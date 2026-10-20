const AI_SDK = "@ai-sdk/openai-compatible";

const ENDPOINTS = {
  kepler: {
    id: "resin-kepler",
    key: "kepler",
    name: "OVH Kepler (no key)",
    baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    modelsEnv: "MAGPIE_MODELS_KEPLER",
  },
  g4fGemini: {
    id: "resin-g4f-gemini",
    key: "g4fGemini",
    name: "G4F Gemini (no key)",
    baseURL: "https://g4f.space/api/gemini-v1beta",
    modelsEnv: "MAGPIE_MODELS_G4F_GEMINI",
  },
  pollinations: {
    id: "resin-pollinations",
    key: "pollinations",
    name: "Pollinations (no key)",
    baseURL: "https://gen.pollinations.ai/v1",
    modelsEnv: "MAGPIE_MODELS_POLLINATIONS",
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
  const ids = parseModelIds(optionIds ?? process.env[endpoint.modelsEnv]);
  return Object.fromEntries(ids.map((id) => [id, modelDefinition(id)]));
}

function endpointConfig(endpoint, options) {
  const envBaseURL = endpoint.urlEnv ? process.env[endpoint.urlEnv] : undefined;
  const baseURL = options?.endpoints?.[endpoint.key]?.baseURL
    ?? envBaseURL
    ?? endpoint.baseURL;
  return { ...endpoint, baseURL: cleanBaseURL(baseURL) };
}

function resinProxyURL(endpoint) {
  const suffix = endpoint.key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const proxy = String(
    process.env[`MAGPIE_RESIN_PROXY_URL_${suffix}`]
      || process.env.MAGPIE_RESIN_PROXY_URL
      || "",
  ).trim();
  if (!proxy) {
    throw new Error(
      `Resin is required for this plugin. Set MAGPIE_RESIN_PROXY_URL${suffix ? `_${suffix}` : ""} to your Resin HTTP proxy URL.`,
    );
  }

  const proxyURL = new URL(proxy);
  if (proxyURL.protocol !== "http:" && proxyURL.protocol !== "https:") {
    throw new Error("MAGPIE_RESIN_PROXY_URL must use an http or https proxy URL.");
  }
  if (proxyURL.pathname !== "/" || proxyURL.search || proxyURL.hash) {
    throw new Error("MAGPIE_RESIN_PROXY_URL must contain only the proxy origin and optional credentials.");
  }
  return proxy;
}

async function fetchThroughResin(endpoint, input, init) {
  const proxy = resinProxyURL(endpoint);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const name of AUTH_HEADERS) headers.delete(name);

  try {
    return await fetch(input, { ...init, headers, proxy });
  } catch (error) {
    const message = String(error?.message ?? error)
      .replaceAll(proxy, "[configured Resin proxy]")
      .replace(/https?:\/\/[^/\s@]+@/g, "http://[proxy credentials]@");
    throw new Error(`Request through Resin failed: ${message}`);
  }
}

function modelRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return [];
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
          fetch: (input, init) => fetchThroughResin(configured, input, init),
        };
      },
    },

    provider: {
      id: configured.id,
      async models(provider) {
        const fallback = () => {
          if (Object.keys(seeds).length) return seeds;
          if (Object.keys(provider.models ?? {}).length) return provider.models;
          return undefined;
        };

        try {
          const response = await fetchThroughResin(
            configured,
            `${configured.baseURL}/models`,
            { method: "GET" },
          );
          if (!response.ok) {
            const existing = fallback();
            if (existing) return existing;
            throw new Error(`${configured.name} /models returned HTTP ${response.status}.`);
          }

          const rows = modelRows(await response.json());
          if (!rows.length) {
            const existing = fallback();
            if (existing) return existing;
            throw new Error(`${configured.name} /models returned no model IDs.`);
          }

          const prior = provider.models ?? {};
          return Object.fromEntries(rows.flatMap((row) => {
            const id = typeof row === "string" ? row : String(row?.id ?? "").trim();
            if (!id) return [];
            const base = seeds[id] ?? prior[id] ?? modelDefinition(id);
            return [[id, { ...base, id, name: row?.name ?? base.name ?? id }]];
          }));
        } catch (error) {
          const existing = fallback();
          if (existing) return existing;
          throw error;
        }
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
