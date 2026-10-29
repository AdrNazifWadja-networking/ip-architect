"use client";

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import {
  AI_MAX_MESSAGES,
  AI_MAX_MESSAGE_CHARS,
  AI_PRESETS,
  AI_PROVIDERS,
  type AiConfig,
  type AiProvider,
  type AssistantReply,
  type ChatMessage,
  type ToolTrace,
} from "@/lib/ai/types";

interface Props {
  initialConfig: AiConfig;
  isAdmin: boolean;
}

interface Turn extends ChatMessage {
  tools?: ToolTrace[];
}

/** Texte de l'assistant : retours à la ligne conservés, `code` mis en forme ; jamais de HTML brut (aucun innerHTML). */
function Rich({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-panel2 px-1 font-mono text-[13px]">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

export function AssistantView({ initialConfig, isAdmin }: Props) {
  const { t } = useI18n();
  const a = t.assistant;
  const [config, setConfig] = useState<AiConfig>(initialConfig);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: "user", content }];
    setTurns(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content: c }) => ({ role, content: c })) }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AssistantReply> & { error?: string };
      if (!res.ok || typeof data.answer !== "string") throw new Error(data.error ?? t.errors.internal);
      setTurns([...next, { role: "assistant", content: data.answer, tools: data.tools ?? [] }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errors.internal);
    } finally {
      setBusy(false);
      setTimeout(() => endRef.current?.scrollIntoView?.({ behavior: "smooth" }), 50);
    }
  };

  const full = turns.length >= AI_MAX_MESSAGES - 1;
  const ready = config.enabled;

  return (
    <div className="space-y-6">
      {ready ? (
        <section className="card flex flex-col gap-4 p-5" aria-label={a.title}>
          {turns.length === 0 ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium text-fg">
                <Sparkles className="h-4 w-4 text-brand" aria-hidden /> {a.chat.emptyTitle}
              </p>
              <div className="flex flex-wrap gap-2">
                {a.chat.examples.map((ex) => (
                  <button key={ex} type="button" onClick={() => send(ex)} disabled={busy} className="rounded-md border border-line bg-panel px-3 py-1.5 text-left text-sm text-fg2 hover:bg-panel2">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="space-y-4" aria-live="polite">
              {turns.map((m, i) => (
                <li key={i} className={m.role === "user" ? "ml-auto max-w-[85%] rounded-lg bg-brand/10 p-3" : "max-w-[95%] rounded-lg border border-line bg-panel2 p-3"}>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{m.role === "user" ? a.chat.you : a.chat.assistant}</p>
                  <Rich text={m.content} />
                  {m.tools && m.tools.length > 0 && (
                    <p className="mt-2 text-[11px] text-muted">
                      {a.chat.toolsUsed} :{" "}
                      {m.tools.map((x, k) => (
                        <span key={k} className="mr-2 inline-block rounded border border-line px-1.5 py-0.5">
                          {(a.chat.tools as Record<string, string>)[x.name] ?? x.name}
                          {x.failed ? ` (${a.chat.toolFailed})` : ""}
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
              {busy && <li className="text-sm text-muted">{a.chat.sending}</li>}
            </ol>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="space-y-2"
          >
            <textarea
              aria-label={a.chat.placeholder}
              className="input h-auto py-2"
              rows={3}
              maxLength={AI_MAX_MESSAGE_CHARS}
              value={input}
              disabled={busy || full}
              placeholder={a.chat.placeholder}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted">{format(a.chat.limit, { chars: AI_MAX_MESSAGE_CHARS, messages: AI_MAX_MESSAGES })}</p>
              <div className="flex gap-2">
                {turns.length > 0 && (
                  <button type="button" className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg2 hover:bg-panel2" onClick={() => { setTurns([]); setError(null); }}>
                    {a.chat.clear}
                  </button>
                )}
                <button type="submit" disabled={busy || full || !input.trim()} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                  {busy ? a.chat.sending : a.chat.send}
                </button>
              </div>
            </div>
          </form>
        </section>
      ) : (
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-fg">{a.disabled.title}</h2>
          <p className="mt-1 text-sm text-muted">{isAdmin ? a.disabled.admin : a.disabled.viewer}</p>
        </section>
      )}

      <p className="text-xs text-muted">{a.privacy}</p>

      {isAdmin && <ConfigPanel config={config} onSaved={setConfig} />}
    </div>
  );
}

function ConfigPanel({ config, onSaved }: { config: AiConfig; onSaved: (c: AiConfig) => void }) {
  const { t } = useI18n();
  const a = t.assistant;
  const c = a.config;
  const [provider, setProvider] = useState<AiProvider>(config.provider);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl || AI_PRESETS[config.provider].baseUrl);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [enabled, setEnabled] = useState(config.enabled);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const choose = (p: AiProvider) => {
    setProvider(p);
    setBaseUrl(AI_PRESETS[p].baseUrl);
    setModel(AI_PRESETS[p].model);
    setModels([]);
    setMsg(null);
  };

  const call = async (url: string, method: string, body: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok) throw new Error(data.error ?? t.errors.internal);
    return data;
  };

  const test = async () => {
    setBusy("test");
    setMsg(null);
    try {
      const data = (await call("/api/assistant/models", "POST", { baseUrl, ...(apiKey ? { apiKey } : {}) })) as { models: string[] };
      setModels(data.models);
      setMsg({ ok: true, text: format(c.testOk, { n: data.models.length }) });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : t.errors.internal });
    } finally {
      setBusy("");
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    try {
      const body: Record<string, unknown> = { provider, baseUrl, model, enabled };
      if (clearKey) body.apiKey = "";
      else if (apiKey) body.apiKey = apiKey;
      const data = (await call("/api/assistant/settings", "PATCH", body)) as { config: AiConfig };
      onSaved(data.config);
      setApiKey("");
      setClearKey(false);
      setMsg({ ok: true, text: c.saved });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t.errors.internal });
    } finally {
      setBusy("");
    }
  };

  const label = "mb-1 block text-xs font-medium text-fg2";
  const needsKey = AI_PRESETS[provider].needsKey;

  return (
    <section className="space-y-4">
      <form onSubmit={save} className="card space-y-4 p-5" aria-label={c.title}>
        <h2 className="text-sm font-semibold text-fg">{c.title}</h2>
        <div role="group" aria-label={c.provider} className="flex flex-wrap gap-2">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === provider}
              onClick={() => choose(p)}
              className={p === provider ? "rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white" : "rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg2 hover:bg-panel2"}
            >
              {c.providers[p]}
            </button>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={label} htmlFor="ai-url">{c.baseUrl}</label>
            <input id="ai-url" className="input font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <label className={label} htmlFor="ai-key">{c.apiKey}</label>
            <input id="ai-key" type="password" autoComplete="off" className="input font-mono" value={apiKey} disabled={!needsKey && provider === "ollama"} onChange={(e) => setApiKey(e.target.value)} />
            <p className="mt-1 text-[11px] text-muted">
              {provider === "ollama" ? c.apiKeyNotNeeded : config.hasKey && !clearKey ? c.apiKeySaved : c.apiKeyNone}
            </p>
            {config.hasKey && (
              <label className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> {c.clearKey}
              </label>
            )}
          </div>
          <div>
            <label className={label} htmlFor="ai-model">{c.model}</label>
            <input id="ai-model" className="input font-mono" value={model} placeholder={c.modelPlaceholder} onChange={(e) => setModel(e.target.value)} spellCheck={false} list="ai-models" />
            <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            {models.length > 0 && (
              <select aria-label={c.pickModel} className="input mt-2" value="" onChange={(e) => e.target.value && setModel(e.target.value)}>
                <option value="">{c.pickModel}</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-fg2">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {c.enabled}
            </label>
          </div>
        </div>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-green-600 dark:text-green-400" : "text-sm text-red-600 dark:text-red-400"}>
            {msg.text}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={test} disabled={busy !== ""} className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-fg2 hover:bg-panel2 disabled:opacity-50">
            {busy === "test" ? c.testing : c.test}
          </button>
          <button type="submit" disabled={busy !== ""} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {c.save}
          </button>
        </div>
        <p className="text-[11px] text-muted">{c.keyNote}</p>
      </form>

      <div className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold text-fg">{a.setup.title}</h2>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-fg">{a.setup.geminiTitle}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">{a.setup.geminiSteps.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
          <div>
            <h3 className="text-sm font-medium text-fg">{a.setup.ollamaTitle}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">{a.setup.ollamaSteps.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        </div>
      </div>
    </section>
  );
}
