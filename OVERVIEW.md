# Providers Manager

Open Providers Manager from the Paseo sidebar: pick an agent, add or reuse a gateway connection, and choose which models appear in the new-session picker. Each model's context window, max output and capabilities (reasoning, image input, tool calls) are stored on the connection and shared by every agent that uses it; the model selection and default model belong to each agent. Changing a shared connection's URL or key updates every configuration that uses it.

Requires Paseo 0.17.4 or a later compatible version, with each agent's CLI installed on the daemon host. The manager shows how each agent connects:

- **Claude Code**: Anthropic Messages gateway. Limits are written only for models Claude Code doesn't know, or for manual values.
- **Codex**: OpenAI Responses gateway. Models in Codex's built-in table keep its limits and reasoning effort options; per-connection alias mapping, effort allowlists, and manual overrides go into a generated model catalog.
- **GitHub Copilot**: Chat Completions, Responses or Anthropic Messages gateway, through the Copilot CLI's providers file.
- **OpenCode**: Chat Completions, Responses or Anthropic Messages gateway, with per-model context window, max output and capabilities stored in private files and injected when opening a session so multiple gateways stay isolated.
- **Pi / Oh My Pi**: Chat Completions, Responses or Anthropic Messages gateway, with per-model context window, max output and capabilities.
- **Antigravity**: Gemini-compatible gateway plus native agy ACP sessions. agy's ACP model picker only accepts its built-in names (for example `gemini-4-argon` or `gemini-3.1-pro`, optionally with `-low/-medium/-high/-xhigh`); gateway models are mapped onto them.
- **fx**: Chat Completions, Responses or Anthropic Messages gateway, written to fx's `settings.json`.
- **Muse Code / Hoplite**: no verifiable custom inference gateway; only their own account model lists can be checked and used.

OpenAI-compatible gateway URLs are used exactly as entered; the plugin never adds `/v1` to them. Anthropic and Gemini gateways accept either the host root or a versioned base, and their own API path (`/v1/messages`, `/v1beta/models`) is added as their clients expect.

## Context window and max output

When a connection is saved or refreshed, the plugin reads the gateway's model list and matches each model by name on [models.dev](https://models.dev), preferring the vendor's own entry:

- Exact matches are used directly, with their source shown.
- Guesses from related models, unpublished output limits and values found only in third-party catalogs are marked “to confirm”; adopt them one by one or all at once.
- OpenAI models default to the 272K price tier; the full window can be chosen per model.
- Embedding, reranking, image and other non-chat models are greyed out and cannot be selected.
- Models no source knows use the connection's fallback (128K / 16K by default).

Manual values win; when an online value changes later, you can compare both and choose. An automatic max output never reaches the context window.

## Testing

“Test all models” re-reads the model list and checks the values the generated configuration will use. It sends no inference requests and uses no tokens. “Send test requests” in the model sheet sends one tiny request to each selected chat model and shows the result on each model.

## Language

Under Settings → Plugins → Providers Manager, choose “Follow Paseo”, “简体中文” or “English”. The choice is stored on the current device.

## Data and security

Connection keys are stored in plain text in the restricted data directory `$PASEO_HOME/plugin-data/paseo-providers-manager/` on the daemon host, and each CLI's launch configuration may also contain the key in Paseo's config or in generated local files. Saved keys are never returned to the manager page. A gateway receives model-list requests, test requests and the model requests of the agents you enable; a copied connection reuses the original key only for the same host and port. models.dev requests go out without credentials. Each enabled combination becomes its own Paseo provider, named after the agent and connection; generated directories are kept for a while after a change so running sessions keep their configuration, then the plugin cleans them up.
