# Magpie Resin OpenAI 兼容供应商

这个 Magpie 插件注册三个无需上游 API key 的 OpenAI 兼容供应商：

| 供应商 ID | 接口地址 |
| --- | --- |
| `resin-kepler` | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` |
| `resin-g4f-gemini` | `https://g4f.space/api/gemini-v1beta` |
| `resin-pollinations` | `https://gen.pollinations.ai/v1` |

插件使用 OpenAI Chat Completions 格式。它不会询问或保存上游 API key，并会从请求中移除 `Authorization`、`x-api-key` 和 `x-goog-api-key` 等认证头。无密钥登录只表示插件不发送 API key；上游仍可能限制匿名额度、要求积分或暂时不可用。

## 安装

在 Magpie 的「扩展 → 插件 → 发现」页面底部输入框填写：

```text
github:121469249/magpie-resin-openai-compatible
```

然后点击「安装」。也可以在本地开发时选择插件文件夹。

插件给每个供应商提供「无需 API Key」登录操作，用于在 Magpie 中登记无密钥账号；这一步不会填写空字符串或伪造 key。

## 配置 Resin

插件通过 Resin 的 HTTP 转发代理访问上游。启动 Magpie 前设置代理 URL：

```sh
export MAGPIE_RESIN_PROXY_URL='http://<用户名>:<代理令牌>@<Resin 地址>:<端口>'
```

请替换为 Resin 的代理地址和凭据。代理 URL 含有凭据，请妥善保管。插件会把它作为 Bun `fetch` 的 `proxy` 选项使用；Resin 用户名中的 `Platform.Account` 决定粘性账号。可以为各供应商分别设置代理 URL，例如 `MAGPIE_RESIN_PROXY_URL_KEPLER`、`MAGPIE_RESIN_PROXY_URL_G4F_GEMINI` 和 `MAGPIE_RESIN_PROXY_URL_POLLINATIONS`。未设置代理 URL 时，请求会报错，不会悄悄直连上游。请在启动 Magpie 的同一环境中设置变量。

## 模型列表

插件会尝试从每个接口的 `GET /models` 自动发现模型。如果某个接口没有实现此路由，可手动指定实际模型 ID：

```sh
magpie plugin options magpie-resin-openai-compatible '{"models":{"kepler":["实际模型 ID"],"g4fGemini":["实际模型 ID"],"pollinations":["实际模型 ID"]}}'
```

也可以在启动 Magpie 前设置逗号分隔的环境变量：

```sh
export MAGPIE_MODELS_KEPLER='实际模型 ID'
export MAGPIE_MODELS_G4F_GEMINI='实际模型 ID'
export MAGPIE_MODELS_POLLINATIONS='实际模型 ID'
```

请使用对应接口 `/models` 返回的模型 ID，或服务运营方提供的模型 ID。

## 添加其他 OpenAI 兼容接口

可通过插件选项启用一个额外的 `resin-custom` 供应商：

```sh
magpie plugin options magpie-resin-openai-compatible '{"custom":{"id":"resin-custom","name":"我的接口","baseURL":"https://api.example.com/v1","modelIds":["实际模型 ID"]}}'
```

自定义供应商也会经过同一 Resin 代理，并采用无 key 登录。要添加多个固定供应商，可在 `index.mjs` 的 `ENDPOINTS` 中添加条目，并为它导出一个插件函数。

## 使用

配置 Resin 和模型 ID 后，无需输入 API key 即可登记供应商并测试模型：

```sh
magpie plugin login resin-kepler
magpie provider test resin-kepler <模型 ID>
```

## 参考

- [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)
- [Resin HTTP 转发代理与粘性账号文档](https://github.com/Resinat/Resin)
