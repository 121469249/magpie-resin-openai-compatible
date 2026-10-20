const AI_SDK = "@ai-sdk/openai-compatible";
const MODEL_DISCOVERY_WAIT_MS = 3000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30000;
const discoveredModels = new Map();
const modelRequests = new Map();

const ENDPOINTS = {
  kepler: {
    id: "resin-kepler",
    key: "kepler",
    name: "OVH Kepler (no key)",
    baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    modelsEnv: "MAGPIE_MODELS_KEPLER",
    fallbackModels: [
      "Qwen3.5-9B",
      "Qwen3.8-27B",
      "gpt-oss-20b",
      "Mistral-Nemo-Instruct-2407",
    ],
  },
  g4fGemini: {
    id: "resin-g4f-gemini",
    key: "g4fGemini",
    name: "G4F Gemini (no key)",
    baseURL: "https://g4f.space/api/gemini-v1beta",
    modelsEnv: "MAGPIE_MODELS_G4F_GEMINI",
    fallbackModels: [
      "models/gemini-3.5-flash-lite",
      "models/gemini-2.5-flash",
    ],
  },
  pollinations: {
    id: "resin-pollinations",
    key: "pollinations",
    name: "Pollinations (no key)",
    baseURL: "https://gen.pollinations.ai/v1",
    modelsEnv: "MAGPIE_MODELS_POLLINATIONS",
    fallbackModels: ["openai/gpt-5.4-nano"],
  },
};

const AUTH_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
];

function cleanBaseURL(value) {
  const url = String(value ?? "").trim();
  if (!url) throw new Error("A provider baseURL is required.");
  return url.replace(/\/+$/, "");
}

function parseModelIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
  }
  return [];
}

function modelDefinition(id, name = id) {
  return {
    id,
    name,
    limit: { context: 32768, output: 4096 },
    tool_call: true,
  };
}

function modelSeeds(endpoint, options) {
  const optionIds = endpoint.key === "custom"
    ? options?.custom?.modelIds
    : options?.models?.[endpoint.key];
  const ids = parseModelIds(
    optionIds ?? process.env[endpoint.modelsEnv] ?? endpoint.fallbackModels,
  );
  return Object.fromEntries(ids.map((id) => [id, modelDefinition(id)]));
}

function endpointConfig(endpoint, options) {
  const envBaseURL = endpoint.urlEnv ? process.env[endpoint.urlEnv] : undefined;
  const baseURL = options?.endpoints?.[endpoint.key]?.baseURL
    ?? envBaseURL
    ?? endpoint.baseURL;
  return { ...endpoint, baseURL: cleanBaseURL(baseURL) };
}

async function fetchWithoutAPIKey(input, init) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const name of AUTH_HEADERS) headers.delete(name);

  try {
    // Magpie applies the proxy configured for this provider/account to the
    // host's standard fetch. Passing a custom `proxy` option here would bypass it.
    return await fetch(input, { ...init, headers });
  } catch (error) {
    const message = String(error?.message ?? error)
      .replace(/https?:\/\/[^/\s@]+@/g, "http://[proxy credentials]@");
    throw new Error(`Request through Magpie failed: ${message}`);
  }
}

function modelRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return [];
}

function modelsFromRows(rows, seeds, prior) {
  return Object.fromEntries(rows.flatMap((row) => {
    const id = typeof row === "string" ? row : String(row?.id ?? "").trim();
    if (!id) return [];
    const base = seeds[id] ?? prior[id] ?? modelDefinition(id);
    return [[id, {
      ...base,
      id,
      name: row?.name ?? row?.display_name ?? row?.title ?? base.name ?? id,
    }]];
  }));
}

function makeProviderPlugin(endpoint, options) {
  const configured = endpointConfig(endpoint, options);
  const seeds = modelSeeds(configured, options);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[configured.id] ??= {
        name: configured.name,
        npm: AI_SDK,
        api: configured.baseURL,
        models: seeds,
      };
    },

    auth: {
      provider: configured.id,
      methods: [{
        type: "oauth",
        label: "无需 API Key",
        async authorize() {
          return {
            instructions: "此供应商不使用 API Key。确认后会添加一个本地无密钥账号。",
            method: "auto",
            async callback() {
              return {
                type: "success",
                refresh: "",
                access: "",
                expires: 0,
                accountId: `no-key:${configured.id}`,
              };
            },
          };
        },
      }],
      async loader() {
        return {
          baseURL: configured.baseURL,
          fetch: fetchWithoutAPIKey,
        };
      },
    },

    provider: {
      id: configured.id,
      async models(provider, { auth } = {}) {
        const fallback = () => {
          const models = Object.keys(seeds).length ? seeds : (provider.models ?? {});
          if (!Object.keys(models).length) return undefined;
          const list = { ...models };
          list[Symbol.for("magpie.fellBack")] = true;
          return list;
        };

        const cacheKey = `${configured.id}:${configured.baseURL}:${auth?.accountId ?? "default"}`;
        const cached = discoveredModels.get(cacheKey);
        if (cached) return cached;

        let request = modelRequests.get(cacheKey);
        if (!request) {
          request = (async () => {
            try {
              const response = await fetch(`${configured.baseURL}/models`, {
                method: "GET",
                signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
              });
              if (!response.ok) return undefined;
              const rows = modelRows(await response.json());
              if (!rows.length) return undefined;
              const models = modelsFromRows(rows, seeds, provider.models ?? {});
              if (!Object.keys(models).length) return undefined;
              discoveredModels.set(cacheKey, models);
              return models;
            } catch {
              return undefined;
            } finally {
              modelRequests.delete(cacheKey);
            }
          })();
          modelRequests.set(cacheKey, request);
        }

        let timer;
        await Promise.race([
          request,
          new Promise((resolve) => { timer = setTimeout(resolve, MODEL_DISCOVERY_WAIT_MS); }),
        ]);
        if (timer) clearTimeout(timer);
        return discoveredModels.get(cacheKey) ?? fallback();
      },
    },
  };
}

export const KeplerPlugin = async (_input, options) =>
  makeProviderPlugin(ENDPOINTS.kepler, options);

export const G4FGeminiPlugin = async (_input, options) =>
  makeProviderPlugin(ENDPOINTS.g4fGemini, options);

export const PollinationsPlugin = async (_input, options) =>
  makeProviderPlugin(ENDPOINTS.pollinations, options);

export const CustomOpenAICompatiblePlugin = async (_input, options) => {
  const custom = options?.custom ?? {};
  const baseURL = custom.baseURL ?? process.env.MAGPIE_CUSTOM_BASE_URL;
  if (!baseURL) return {};

  const id = String(custom.id ?? "resin-custom").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("custom.id must contain lowercase letters, numbers, and hyphens.");
  }

  return makeProviderPlugin({
    id,
    key: "custom",
    name: String(custom.name ?? "Custom OpenAI-compatible API"),
    baseURL,
    urlEnv: "MAGPIE_CUSTOM_BASE_URL",
    modelsEnv: "MAGPIE_MODELS_CUSTOM",
  }, options);
};
