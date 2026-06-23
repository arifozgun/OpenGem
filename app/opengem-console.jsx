"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import {
  Activity,
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  Clipboard,
  Copy,
  Database,
  Edit3,
  ExternalLink,
  Gauge,
  GitFork,
  History,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  Monitor,
  MonitorSmartphone,
  Moon,
  Palette,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Users,
  XCircle,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import logoBlack from "./assets/logo-black.png";
import geminiIcon from "./assets/gemini.png";
import openaiIcon from "./assets/openai.svg";
import claudeIcon from "./assets/claude.svg";

const PAGES = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "keys", label: "API Keys", icon: KeyRound },
  { id: "logs", label: "Logs", icon: Server },
  { id: "requests", label: "Requests", icon: Activity },
  { id: "docs", label: "Documentation", icon: BookOpen },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "settings", label: "Settings", icon: Settings },
];

const MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-low",
];

const DEFAULT_DASHBOARD_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_THEME_MODE = "light";
const DEFAULT_HIGHLIGHT_COLOR = "#ea580c";
const APPEARANCE_STORAGE = {
  theme: "opengem-theme",
  highlight: "opengem-highlight",
};

const THEME_OPTIONS = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

const HIGHLIGHT_PRESETS = ["#ea580c", "#f97316", "#22c55e", "#0ea5e9", "#8b5cf6", "#e11d48"];

const defaultSecuritySettings = {
  smtp: {
    host: "",
    port: 587,
    secure: false,
    username: "",
    password: "",
    fromEmail: "",
    toEmail: "",
    configured: false,
    passwordSet: false,
  },
  logging: {
    requests: { maxDaysRetention: 30, enableIpLogging: false },
    logs: { maxDaysRetention: 14, enableIpLogging: false },
  },
};

const firebaseFields = [
  ["apiKey", "API Key", "AIzaSy..."],
  ["authDomain", "Auth Domain", "your-app.firebaseapp.com"],
  ["projectId", "Project ID", "your-project-id"],
  ["storageBucket", "Storage Bucket", "your-app.appspot.com"],
  ["messagingSenderId", "Messaging Sender ID", "123456789"],
  ["appId", "App ID", "1:123456:web:abc123"],
  ["measurementId", "Measurement ID", "G-XXXXXXXXXX"],
];

const featureSnippets = {
  streaming: {
    label: "Streaming",
    body: `for chunk in client.models.generate_content_stream(
    model="gemini-3.1-pro-preview",
    contents="Tell me a long story."
):
    print(chunk.text, end="", flush=True)`,
  },
  systemprompt: {
    label: "System Prompt",
    body: `{
  "systemInstruction": { "parts": [{"text": "You are a helpful assistant."}] },
  "contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]
}`,
  },
  thinking: {
    label: "Thinking",
    body: `{
  "contents": [{"parts": [{"text": "Solve step by step: ..."}]}],
  "generationConfig": { "thinkingConfig": { "includeThoughts": true } }
}`,
  },
  routing: {
    label: "Routing",
    body: `{
  "model": "openai/gpt-5",
  "models": ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
  "session_id": "agent-run-42",
  "provider": { "order": ["openai", "anthropic"], "allow_fallbacks": true },
  "messages": [{"role": "user", "content": "Keep this task on one account."}]
}`,
  },
};

const codeExamples = {
  curl: {
    label: "cURL",
    body: (baseUrl) => `curl -X POST "${baseUrl}/v1beta/models/gemini-3.1-pro-preview:generateContent?key=sk-your-api-key" \\
  -H "Content-Type: application/json" \\
  -d '{"contents": [{"parts": [{"text": "Hello!"}]}]}'`,
  },
  python: {
    label: "Gemini Python",
    body: (baseUrl) => `from google import genai

client = genai.Client(
    api_key="sk-your-api-key",
    http_options={"api_version": "v1beta", "url": "${baseUrl}"}
)

response = client.models.generate_content(model="gemini-3.1-pro-preview", contents="Hello!")
print(response.text)`,
  },
  javascript: {
    label: "Gemini JS",
    body: (baseUrl) => `import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: "sk-your-api-key",
  baseUrl: "${baseUrl}",
});

const response = await ai.models.generateContent({
  model: "gemini-3.1-pro-preview",
  contents: "Hello!",
});

console.log(response.text);`,
  },
  openai: {
    label: "OpenAI",
    body: (baseUrl) => `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-your-api-key",
  baseURL: "${baseUrl}/v1",
});

const stream = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello, who are you?" }],
  stream: true,
});`,
  },
  responses: {
    label: "Responses",
    body: (baseUrl) => `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-your-api-key",
  baseURL: "${baseUrl}/v1",
});

const response = await client.responses.create({
  model: "gpt-5-mini",
  input: "Summarize OpenGem in one sentence.",
  max_output_tokens: 256,
});

console.log(response.output_text);`,
  },
  openrouter: {
    label: "OpenRouter",
    body: (baseUrl) => `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-your-api-key",
  baseURL: "${baseUrl}/api/v1",
});

const response = await client.chat.completions.create({
  model: "openai/gpt-5",
  models: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
  session_id: "agent-run-42",
  provider: { order: ["openai", "anthropic"], allow_fallbacks: true },
  messages: [{ role: "user", content: "Continue this task on a stable route." }],
});`,
  },
  anthropic: {
    label: "Anthropic",
    body: (baseUrl) => `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "sk-your-api-key",
  baseURL: "${baseUrl}",
});

const message = await client.messages.create({
  model: "claude-3-5-sonnet-latest",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a haiku about Gemini." }],
});`,
  },
};

const systemPrompt = `You are an AI assistant running inside OpenGem — an open-source, self-hosted reverse proxy gateway for the Google Gemini API.

Key facts about OpenGem:
- OpenGem lets users access the Gemini API for free by rotating multiple Google OAuth accounts.
- It acts as a drop-in replacement for the official Gemini API endpoint.
- Built with Node.js, Express, TypeScript and a Next.js admin console.
- Supports Firebase Firestore and local SQLite storage backends.
- Features: multi-account rotation, automatic failover, API key management, request logging, streaming, model fallback and automatic account reactivation.
- Supported models include Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3 Flash and related variants.

You are helpful, concise and knowledgeable. Use Markdown formatting for clarity.`;

function getInitialPage() {
  if (typeof window === "undefined") return "overview";
  const slug = window.location.pathname.replace(/^\/+/, "") || "overview";
  return PAGES.some((page) => page.id === slug) ? slug : "overview";
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(number);
}

function formatTime(value) {
  if (!value) return "-";
  try {
    const date = new Date(value);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    if (diffMins < 10080) return `${Math.floor(diffMins / 1440)}d ago`;
    return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "-";
  }
}

function formatMs(value) {
  const number = Number(value || 0);
  if (number >= 1000) return `${(number / 1000).toFixed(2)}s`;
  return `${Math.max(0, Math.round(number))}ms`;
}

function truncateText(value, max = 60) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "-";
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function searchableLogText(log) {
  return Object.values(log || {})
    .map((value) => {
      if (value === null || value === undefined) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    })
    .join(" ")
    .toLowerCase();
}

function filterLogs(logs, query) {
  const term = String(query || "").trim().toLowerCase();
  if (!term) return logs;
  return logs.filter((log) => searchableLogText(log).includes(term));
}

function statusBadgeVariant(status, success = true) {
  const number = Number(status);
  if (!success || number >= 500) return "destructive";
  if (number >= 400) return "secondary";
  return "success";
}

function normalizeHexColor(value) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : DEFAULT_HIGHLIGHT_COLOR;
}

function readableForeground(hexColor) {
  const color = normalizeHexColor(hexColor).slice(1);
  const r = parseInt(color.slice(0, 2), 16) / 255;
  const g = parseInt(color.slice(2, 4), 16) / 255;
  const b = parseInt(color.slice(4, 6), 16) / 255;
  const normalize = (channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
  return luminance > 0.55 ? "#111827" : "#ffffff";
}

function readStoredAppearance() {
  if (typeof window === "undefined") {
    return { theme: DEFAULT_THEME_MODE, highlightColor: DEFAULT_HIGHLIGHT_COLOR };
  }
  const theme = localStorage.getItem(APPEARANCE_STORAGE.theme);
  return {
    theme: THEME_OPTIONS.some((option) => option.id === theme) ? theme : DEFAULT_THEME_MODE,
    highlightColor: normalizeHexColor(localStorage.getItem(APPEARANCE_STORAGE.highlight)),
  };
}

function applyAppearance(appearance) {
  if (typeof document === "undefined") return;
  const theme = appearance?.theme || DEFAULT_THEME_MODE;
  const highlightColor = normalizeHexColor(appearance?.highlightColor);
  const prefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.setProperty("--highlight-color", highlightColor);
  root.style.setProperty("--highlight-foreground", readableForeground(highlightColor));
}

function censorEmail(email, enabled) {
  if (!email) return "-";
  if (!enabled) return email;
  const [name, domain] = String(email).split("@");
  if (!domain) return email;
  return `${name.slice(0, 1)}${"*".repeat(Math.max(4, name.length - 1))}@${domain}`;
}

function isTaskLog(log) {
  const question = log?.question || "";
  const answer = log?.answer || "";
  return (
    question.includes("[TASK RESUMPTION]") ||
    question.includes("<task>") ||
    question.includes("toolConfig") ||
    question.includes("<environment_details>") ||
    question.includes("[Tool Response:") ||
    (question === "Unknown" && answer.includes("**"))
  );
}

function compactChatTitle(text) {
  const title = String(text || "").replace(/\s+/g, " ").trim();
  return (title || "New chat").slice(0, 80);
}

function titleFromMessages(messages) {
  return compactChatTitle(messages.find((message) => message.role === "user")?.text);
}

function cleanChatMessageForSave(message) {
  return {
    id: message.id,
    role: message.role,
    text: message.text || "",
    ...(message.thought ? { thought: message.thought } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.forkedFromMessageId ? { forkedFromMessageId: message.forkedFromMessageId } : {}),
  };
}

function persistableChatMessages(messages) {
  return messages.filter((message) => !message.loading).map(cleanChatMessageForSave);
}

function messagesToContents(messages) {
  return messages
    .filter((message) => !message.loading && !message.error && message.text?.trim())
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.text }],
    }));
}

function hydrateChatMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    id: message.id || crypto.randomUUID(),
    role: message.role === "assistant" ? "assistant" : "user",
    text: message.text || "",
    ...(message.thought ? { thought: message.thought } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.forkedFromMessageId ? { forkedFromMessageId: message.forkedFromMessageId } : {}),
  }));
}

function chatSummaryFromConversation(conversation) {
  return {
    id: conversation.id,
    title: conversation.title || titleFromMessages(conversation.messages || []),
    model: conversation.model || DEFAULT_DASHBOARD_MODEL,
    sessionId: conversation.sessionId,
    messageCount: conversation.messageCount ?? conversation.messages?.length ?? 0,
    ...(conversation.forkedFromId ? { forkedFromId: conversation.forkedFromId } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function upsertChatSummary(list, conversation) {
  const summary = chatSummaryFromConversation(conversation);
  return [summary, ...list.filter((item) => item.id !== summary.id)].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );
}

export function parseFirebaseText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const extract = (key) => {
      const match = text.match(new RegExp(`(?:["']?${key}["']?\\s*:\\s*)(["'])(.*?)\\1`));
      return match ? match[2] : "";
    };
    const parsed = Object.fromEntries(firebaseFields.map(([key]) => [key, extract(key)]));
    return parsed.apiKey ? parsed : null;
  }
}

async function copyText(text) {
  if (!text) return;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text).catch(() => {});
  }
}

function getCookie(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function csrfHeaders(method = "GET") {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(String(method).toUpperCase())) return {};
  const token = getCookie("admin_csrf");
  return token ? { "x-csrf-token": token } : {};
}

function markdownHtml(text) {
  return { __html: sanitizeMarkedHtml(marked.parse(text || "")) };
}

const markdownAllowedTags = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "LI",
  "OL",
  "P",
  "PRE",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

function sanitizeMarkedHtml(html) {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return String(html || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  root.querySelectorAll("script,style,iframe,object,embed,link,meta,base,form,input,button,select,textarea,svg,math").forEach((node) => node.remove());
  Array.from(root.querySelectorAll("*")).forEach((node) => {
    if (!markdownAllowedTags.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") {
        node.removeAttribute(attr.name);
        continue;
      }
      if (node.tagName === "A" && ["href", "title"].includes(name)) {
        if (name === "href" && !/^(https?:|mailto:)/i.test(value)) {
          node.removeAttribute(attr.name);
        }
        continue;
      }
      if (name !== "href" && name !== "title") {
        node.removeAttribute(attr.name);
      }
    }
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("rel", "noreferrer noopener");
      node.setAttribute("target", "_blank");
    }
  });
  return root.innerHTML || "";
}

function InlineLogo({ className }) {
  return (
    <img
      src={logoBlack.src}
      alt="OpenGem"
      className={cn("size-8 object-contain dark:invert", className)}
    />
  );
}

function LoadingScreen({ label = "Verifying session..." }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
        <Loader2 className="animate-spin" data-icon="inline-start" />
        {label}
      </div>
    </main>
  );
}

function ErrorNotice({ children }) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle data-icon="inline-start" />
      <span>{children}</span>
    </div>
  );
}

function PageHeader({ title, description, children }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

function StatusBadge({ active, label }) {
  return active ? (
    <Badge variant="success">
      <CheckCircle2 data-icon="inline-start" />
      {label || "Active"}
    </Badge>
  ) : (
    <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
      <XCircle data-icon="inline-start" />
      {label || "Exhausted"}
    </Badge>
  );
}

function TableEmpty({ colSpan, children }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-24 text-center text-sm text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

function MetricCard({ icon: Icon, label, value, tone = "primary" }) {
  const tones = {
    primary: "bg-primary/10 text-primary ring-primary/20",
    success: "bg-accent text-accent-foreground ring-accent-foreground/15",
    muted: "bg-secondary text-secondary-foreground ring-secondary-foreground/15",
    warn: "bg-amber-100 text-amber-900 ring-amber-300",
  };
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={cn("flex size-11 items-center justify-center rounded-lg ring-1", tones[tone])}>
          <Icon />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-normal">{value ?? "-"}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function LogTimelineChart({ logs, label = "events" }) {
  const points = useMemo(() => {
    const HOURS = 24;
    const HOUR_MS = 60 * 60 * 1000;
    const current = new Date();
    current.setMinutes(0, 0, 0);
    const start = current.getTime() - (HOURS - 1) * HOUR_MS;

    // Pre-seed a fixed window of 24 hourly buckets so empty hours still render.
    const buckets = new Map();
    for (let i = 0; i < HOURS; i += 1) {
      buckets.set(start + i * HOUR_MS, 0);
    }

    for (const log of logs || []) {
      const date = new Date(log.timestamp);
      if (Number.isNaN(date.getTime())) continue;
      date.setMinutes(0, 0, 0);
      const key = date.getTime();
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
    }

    return [...buckets.entries()].map(([key, count]) => ({
      key,
      count,
      label: new Date(key).toLocaleTimeString("en-US", { hour: "2-digit" }),
    }));
  }, [logs]);
  const max = Math.max(1, ...points.map((point) => point.count));
  const total = points.reduce((sum, point) => sum + point.count, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Timeline</CardTitle>
        <CardDescription>{formatNumber(total)} {label} in the last 24 hours</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-36 items-end gap-2 overflow-x-auto">
          {points.length ? points.map((point) => (
            <Tooltip key={point.key}>
              <TooltipTrigger asChild>
                <div className="flex h-full min-w-10 flex-col justify-end gap-2">
                  <div
                    className="rounded-t-md bg-primary/75"
                    style={{ height: `${Math.max(8, (point.count / max) * 112)}px` }}
                  />
                  <div className="text-center text-[10px] text-muted-foreground">{point.label}</div>
                </div>
              </TooltipTrigger>
              <TooltipContent>{point.count} {label} around {point.label}</TooltipContent>
            </Tooltip>
          )) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">No log activity yet.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(challengeId ? "/api/admin/login/verify" : "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(challengeId ? { challengeId, code } : { username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Invalid credentials or rate limit exceeded.");
      if (data.requiresTwoFactor && data.challengeId) {
        setChallengeId(data.challengeId);
        setPassword("");
        setCode("");
        setNotice(data.message || "Verification code sent.");
        return;
      }
      setUsername("");
      setPassword("");
      setChallengeId("");
      setCode("");
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-xl bg-card ring-1 ring-border">
            <InlineLogo className="size-10" />
          </div>
          <CardTitle className="text-2xl">OpenGem</CardTitle>
          <CardDescription>{challengeId ? "Enter the emailed verification code" : "Sign in to your admin dashboard"}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {!challengeId ? (
              <>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Username
                  <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Password
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-2 text-sm font-medium">
                Verification Code
                <Input
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                />
              </label>
            )}
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <LogIn data-icon="inline-start" />}
              {challengeId ? "Verify" : "Sign In"}
            </Button>
            {challengeId ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setChallengeId("");
                  setCode("");
                  setNotice("");
                  setError("");
                }}
              >
                Back to Sign In
              </Button>
            ) : null}
            {notice ? <div className="rounded-lg border bg-muted/45 px-3 py-2 text-sm text-muted-foreground">{notice}</div> : null}
            <ErrorNotice>{error}</ErrorNotice>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export function OpenGemConsole() {
  const [view, setView] = useState("checking");
  const [currentPage, setCurrentPage] = useState(getInitialPage);
  const [baseUrl, setBaseUrl] = useState("http://localhost:3050");
  const [appearance, setAppearance] = useState(readStoredAppearance);
  const [privacyMode, setPrivacyMode] = useState(false);
  const [stats, setStats] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [keys, setKeys] = useState([]);
  const [logs, setLogs] = useState([]);
  const [serverLogs, setServerLogs] = useState([]);
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [selectedLog, setSelectedLog] = useState(null);
  const [selectedServerLog, setSelectedServerLog] = useState(null);
  const [requestSearch, setRequestSearch] = useState("");
  const [serverLogSearch, setServerLogSearch] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [dbBackend, setDbBackend] = useState("");
  const [dbSwitchOpen, setDbSwitchOpen] = useState(false);
  const [dbSwitchError, setDbSwitchError] = useState("");
  const [dbSwitchLoading, setDbSwitchLoading] = useState(false);
  const [switchFirebase, setSwitchFirebase] = useState({});
  const [confirmAction, setConfirmAction] = useState(null);
  const [confirmActionError, setConfirmActionError] = useState("");
  const [confirmActionLoading, setConfirmActionLoading] = useState(false);
  const [pasteConfigOpen, setPasteConfigOpen] = useState(false);
  const [pasteConfigText, setPasteConfigText] = useState("");
  const [pasteConfigError, setPasteConfigError] = useState("");
  const [credForm, setCredForm] = useState({ currentPassword: "", newUsername: "", newPassword: "", confirmPassword: "" });
  const [credStatus, setCredStatus] = useState("");
  const [securitySettings, setSecuritySettings] = useState(defaultSecuritySettings);
  const [securityStatus, setSecurityStatus] = useState("");
  const [playground, setPlayground] = useState({ apiKey: "", model: DEFAULT_DASHBOARD_MODEL, message: "", response: "Awaiting response..." });
  const [playgroundLoading, setPlaygroundLoading] = useState(false);
  const [featureTab, setFeatureTab] = useState("streaming");
  const [codeTab, setCodeTab] = useState("curl");
  const [chatModel, setChatModel] = useState(DEFAULT_DASHBOARD_MODEL);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatContents, setChatContents] = useState([]);
  const [chatSending, setChatSending] = useState(false);
  const [chatConversations, setChatConversations] = useState([]);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [chatHistoryError, setChatHistoryError] = useState("");
  const [activeConversationId, setActiveConversationId] = useState(() => crypto.randomUUID());
  const [chatTitle, setChatTitle] = useState("New chat");
  const [chatSessionId, setChatSessionId] = useState(() => crypto.randomUUID());
  const chatScrollRef = useRef(null);

  const activePage = useMemo(() => PAGES.find((page) => page.id === currentPage) || PAGES[0], [currentPage]);
  const ActiveIcon = activePage.icon;
  const switchTarget = dbBackend === "local" ? "firebase" : "local";

  const requestJson = useCallback(async (url, options = {}) => {
    const res = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...csrfHeaders(options.method),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      setView("login");
      throw new Error("Unauthorized");
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const error = new Error(data.error || "Request failed.");
      error.status = res.status;
      throw error;
    }
    return data;
  }, []);

  const setLoadingKey = useCallback((key, value) => {
    setLoading((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setErrorKey = useCallback((key, value) => {
    setErrors((prev) => ({ ...prev, [key]: value }));
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/me", { credentials: "same-origin" });
      setView(res.ok ? "dashboard" : "login");
    } catch {
      setView("login");
    }
  }, []);

  useEffect(() => {
    setBaseUrl(window.location.origin);
    setPrivacyMode(localStorage.getItem("privacyMode") === "true");
    checkSession();
    const onPop = () => setCurrentPage(getInitialPage());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [checkSession]);

  useEffect(() => {
    applyAppearance(appearance);
    localStorage.setItem(APPEARANCE_STORAGE.theme, appearance.theme);
    localStorage.setItem(APPEARANCE_STORAGE.highlight, normalizeHexColor(appearance.highlightColor));
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (appearance.theme !== "system" || !media) return undefined;
    const onChange = () => applyAppearance(appearance);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [appearance]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const loadStats = useCallback(async () => {
    setLoadingKey("stats", true);
    setErrorKey("stats", "");
    try {
      setStats(await requestJson("/api/stats"));
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("stats", err.message);
    } finally {
      setLoadingKey("stats", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadAccounts = useCallback(async () => {
    setLoadingKey("accounts", true);
    setErrorKey("accounts", "");
    try {
      setAccounts(await requestJson("/api/accounts"));
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("accounts", err.message);
    } finally {
      setLoadingKey("accounts", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadKeys = useCallback(async () => {
    setLoadingKey("keys", true);
    setErrorKey("keys", "");
    try {
      setKeys(await requestJson("/api/keys"));
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("keys", err.message);
    } finally {
      setLoadingKey("keys", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadRequests = useCallback(async () => {
    setLoadingKey("requests", true);
    setErrorKey("requests", "");
    try {
      setLogs(await requestJson("/api/requests?limit=500"));
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("requests", err.message);
    } finally {
      setLoadingKey("requests", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadServerLogs = useCallback(async () => {
    setLoadingKey("logs", true);
    setErrorKey("logs", "");
    try {
      setServerLogs(await requestJson("/api/server-logs?limit=1000"));
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("logs", err.message);
    } finally {
      setLoadingKey("logs", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadDbStatus = useCallback(async () => {
    setLoadingKey("db", true);
    try {
      const data = await requestJson("/api/admin/db-status");
      setDbBackend(data.backend || "firebase");
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("db", err.message);
    } finally {
      setLoadingKey("db", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadSecuritySettings = useCallback(async () => {
    setLoadingKey("security", true);
    setErrorKey("security", "");
    try {
      const data = await requestJson("/api/admin/security-settings");
      setSecuritySettings({
        smtp: { ...defaultSecuritySettings.smtp, ...(data.smtp || {}), password: "" },
        logging: {
          requests: { ...defaultSecuritySettings.logging.requests, ...(data.logging?.requests || {}) },
          logs: { ...defaultSecuritySettings.logging.logs, ...(data.logging?.logs || {}) },
        },
      });
    } catch (err) {
      if (err.message !== "Unauthorized") setErrorKey("security", err.message);
    } finally {
      setLoadingKey("security", false);
    }
  }, [requestJson, setErrorKey, setLoadingKey]);

  const loadChatConversations = useCallback(async () => {
    setChatHistoryLoading(true);
    setChatHistoryError("");
    try {
      setChatConversations(await requestJson("/api/admin/chat/conversations?limit=100"));
    } catch (err) {
      if (err.message !== "Unauthorized") setChatHistoryError(err.message);
    } finally {
      setChatHistoryLoading(false);
    }
  }, [requestJson]);

  const saveChatConversation = useCallback(async ({ id, title, model, sessionId, messages, forkedFromId }) => {
    const cleanMessages = persistableChatMessages(messages);
    if (!cleanMessages.length) return null;
    try {
      const saved = await requestJson(`/api/admin/chat/conversations/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({
          title: title || titleFromMessages(cleanMessages),
          model: model || DEFAULT_DASHBOARD_MODEL,
          sessionId,
          messages: cleanMessages,
          ...(forkedFromId ? { forkedFromId } : {}),
        }),
      });
      setChatConversations((prev) => upsertChatSummary(prev, saved));
      setChatHistoryError("");
      return saved;
    } catch (err) {
      if (err.message !== "Unauthorized") setChatHistoryError(err.message || "Failed to save chat.");
      return null;
    }
  }, [requestJson]);

  useEffect(() => {
    if (view !== "dashboard") return;
    if (currentPage === "overview") loadStats();
    if (currentPage === "accounts") loadAccounts();
    if (currentPage === "keys") loadKeys();
    if (currentPage === "logs") loadServerLogs();
    if (currentPage === "requests") loadRequests();
    if (currentPage === "settings") {
      loadDbStatus();
      loadSecuritySettings();
    }
    if (currentPage === "chat") loadChatConversations();
  }, [currentPage, loadAccounts, loadChatConversations, loadDbStatus, loadKeys, loadRequests, loadSecuritySettings, loadServerLogs, loadStats, view]);

  function navigate(pageId) {
    setCurrentPage(pageId);
    const path = pageId === "overview" ? "/" : `/${pageId}`;
    if (window.location.pathname !== path) {
      window.history.pushState({ page: pageId }, "", path);
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin", headers: csrfHeaders("POST") }).catch(() => {});
    setView("login");
  }

  function updatePrivacyMode(enabled) {
    setPrivacyMode(enabled);
    localStorage.setItem("privacyMode", String(enabled));
  }

  function updateThemeMode(theme) {
    setAppearance((prev) => ({
      ...prev,
      theme: THEME_OPTIONS.some((option) => option.id === theme) ? theme : DEFAULT_THEME_MODE,
    }));
  }

  function updateHighlightColor(color) {
    setAppearance((prev) => ({ ...prev, highlightColor: normalizeHexColor(color) }));
  }

  function resetHighlightColor() {
    setAppearance((prev) => ({ ...prev, highlightColor: DEFAULT_HIGHLIGHT_COLOR }));
  }

  async function reactivateAccount(id) {
    await requestJson(`/api/accounts/${encodeURIComponent(id)}/reactivate`, { method: "PUT" });
    await loadAccounts();
    await loadStats();
  }

  function deleteAccount(id) {
    setConfirmActionError("");
    setConfirmAction({
      title: "Remove Account",
      description: "This account will be removed from OpenGem and stop serving gateway requests.",
      confirmLabel: "Remove Account",
      destructive: true,
      onConfirm: async () => {
        await requestJson(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
        await loadAccounts();
        await loadStats();
      },
    });
  }

  async function createKey(event) {
    event.preventDefault();
    if (!newKeyName.trim()) return;
    const data = await requestJson("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: newKeyName.trim() }),
    });
    setNewKeyValue(data.key || "");
    setNewKeyName("");
    await loadKeys();
  }

  function deleteKey(id, name) {
    setConfirmActionError("");
    setConfirmAction({
      title: "Delete API Key",
      description: `Delete API key "${name}"? Applications using this key will stop working.`,
      confirmLabel: "Delete Key",
      destructive: true,
      onConfirm: async () => {
        await requestJson(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
        await loadKeys();
      },
    });
  }

  function pasteSwitchFirebase() {
    setDbSwitchError("");
    setPasteConfigText("");
    setPasteConfigError("");
    setPasteConfigOpen(true);
  }

  function applySwitchFirebaseText(text) {
    const parsed = parseFirebaseText(text);
    if (!parsed) {
      setPasteConfigError("Could not parse Firebase config. Please paste a valid JSON object.");
      return;
    }
    setSwitchFirebase((prev) => ({ ...prev, ...parsed }));
    setPasteConfigOpen(false);
    setPasteConfigText("");
    setPasteConfigError("");
  }

  async function confirmActionRequest() {
    if (!confirmAction?.onConfirm) return;
    setConfirmActionLoading(true);
    setConfirmActionError("");
    try {
      await confirmAction.onConfirm();
      setConfirmAction(null);
    } catch (err) {
      if (err.message === "Unauthorized") {
        setConfirmAction(null);
      } else {
        setConfirmActionError(err.message || "Action failed.");
      }
    } finally {
      setConfirmActionLoading(false);
    }
  }

  async function confirmDbSwitch() {
    setDbSwitchError("");
    setDbSwitchLoading(true);
    try {
      if (switchTarget === "firebase") {
        const missing = firebaseFields
          .filter(([key]) => key !== "measurementId")
          .filter(([key]) => !String(switchFirebase[key] || "").trim());
        if (missing.length) throw new Error("Missing required Firebase configuration fields.");
      }
      const data = await requestJson("/api/admin/db-switch", {
        method: "POST",
        body: JSON.stringify({
          to: switchTarget,
          firebase: switchTarget === "firebase" ? switchFirebase : undefined,
        }),
      });
      setDbBackend(data.backend || switchTarget);
      setDbSwitchError(data.note || "Database switch complete. The server is restarting.");
      setTimeout(() => window.location.reload(), 1800);
    } catch (err) {
      if (err.message !== "Unauthorized") setDbSwitchError(err.message);
    } finally {
      setDbSwitchLoading(false);
    }
  }

  async function updateCredentials(event) {
    event.preventDefault();
    setCredStatus("");
    if (credForm.newPassword !== credForm.confirmPassword) {
      setCredStatus("New passwords do not match.");
      return;
    }
    try {
      const data = await requestJson("/api/admin/credentials", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: credForm.currentPassword,
          newUsername: credForm.newUsername,
          newPassword: credForm.newPassword,
        }),
      });
      setCredStatus(data.message || "Credentials updated. Please log in again.");
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      if (err.message !== "Unauthorized") setCredStatus(err.message);
    }
  }

  function updateSmtpField(key, value) {
    setSecuritySettings((prev) => ({
      ...prev,
      smtp: { ...prev.smtp, [key]: value },
    }));
  }

  function updateLoggingField(section, key, value) {
    setSecuritySettings((prev) => ({
      ...prev,
      logging: {
        ...prev.logging,
        [section]: {
          ...prev.logging[section],
          [key]: value,
        },
      },
    }));
  }

  async function saveSecuritySettings(event) {
    event.preventDefault();
    setSecurityStatus("");
    try {
      const data = await requestJson("/api/admin/security-settings", {
        method: "POST",
        body: JSON.stringify({
          smtp: securitySettings.smtp,
          logging: securitySettings.logging,
        }),
      });
      setSecuritySettings({
        smtp: { ...defaultSecuritySettings.smtp, ...(data.smtp || {}), password: "" },
        logging: {
          requests: { ...defaultSecuritySettings.logging.requests, ...(data.logging?.requests || {}) },
          logs: { ...defaultSecuritySettings.logging.logs, ...(data.logging?.logs || {}) },
        },
      });
      setSecurityStatus("Security settings updated.");
    } catch (err) {
      if (err.message !== "Unauthorized") setSecurityStatus(err.message);
    }
  }

  async function clearSmtpSettings() {
    setSecurityStatus("");
    try {
      const data = await requestJson("/api/admin/security-settings", {
        method: "POST",
        body: JSON.stringify({
          smtp: { clear: true },
          logging: securitySettings.logging,
        }),
      });
      setSecuritySettings({
        smtp: { ...defaultSecuritySettings.smtp, ...(data.smtp || {}), password: "" },
        logging: {
          requests: { ...defaultSecuritySettings.logging.requests, ...(data.logging?.requests || {}) },
          logs: { ...defaultSecuritySettings.logging.logs, ...(data.logging?.logs || {}) },
        },
      });
      setSecurityStatus("Email 2FA disabled.");
    } catch (err) {
      if (err.message !== "Unauthorized") setSecurityStatus(err.message);
    }
  }

  async function sendPlayground() {
    if (!playground.apiKey.trim()) {
      setPlayground((prev) => ({ ...prev, response: "Enter an API key first." }));
      return;
    }
    if (!playground.message.trim()) {
      setPlayground((prev) => ({ ...prev, response: "Enter a message first." }));
      return;
    }
    setPlaygroundLoading(true);
    setPlayground((prev) => ({ ...prev, response: "Generating..." }));
    try {
      const res = await fetch(`${baseUrl}/v1beta/models/${playground.model}:generateContent?key=${encodeURIComponent(playground.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: playground.message }] }] }),
      });
      const data = await res.json();
      setPlayground((prev) => ({ ...prev, response: JSON.stringify(data, null, 2) }));
    } catch (err) {
      setPlayground((prev) => ({ ...prev, response: `Network error: ${err.message}` }));
    } finally {
      setPlaygroundLoading(false);
    }
  }

  function startNewChat() {
    const id = crypto.randomUUID();
    setActiveConversationId(id);
    setChatTitle("New chat");
    setChatMessages([]);
    setChatContents([]);
    setChatInput("");
    setChatSessionId(crypto.randomUUID());
    setChatModel(DEFAULT_DASHBOARD_MODEL);
    setChatHistoryError("");
  }

  async function loadChatConversation(id) {
    if (!id || chatSending) return;
    setChatHistoryLoading(true);
    setChatHistoryError("");
    try {
      const conversation = await requestJson(`/api/admin/chat/conversations/${encodeURIComponent(id)}`);
      const messages = hydrateChatMessages(conversation.messages);
      setActiveConversationId(conversation.id);
      setChatTitle(conversation.title || titleFromMessages(messages));
      setChatModel(conversation.model || DEFAULT_DASHBOARD_MODEL);
      setChatSessionId(conversation.sessionId || crypto.randomUUID());
      setChatMessages(messages);
      setChatContents(messagesToContents(messages));
      setChatInput("");
      setChatConversations((prev) => upsertChatSummary(prev, conversation));
    } catch (err) {
      if (err.message === "Unauthorized") return;
      if (err.status === 404) {
        setChatConversations((prev) => prev.filter((item) => item.id !== id));
        if (activeConversationId === id) startNewChat();
        setChatHistoryError("That chat is no longer available and was removed from history.");
        return;
      }
      setChatHistoryError(err.message || "Failed to load chat.");
    } finally {
      setChatHistoryLoading(false);
    }
  }

  function deleteChatConversation(id, title) {
    setConfirmActionError("");
    setConfirmAction({
      title: "Delete Chat",
      description: `Delete "${title || "this chat"}" from admin chat history?`,
      confirmLabel: "Delete Chat",
      destructive: true,
      onConfirm: async () => {
        await requestJson(`/api/admin/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
        setChatConversations((prev) => prev.filter((item) => item.id !== id));
        if (activeConversationId === id) startNewChat();
      },
    });
  }

  async function forkChatFromMessage(messageId) {
    if (chatSending) return;
    const index = chatMessages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const forkedMessages = chatMessages.slice(0, index + 1).filter((message) => !message.loading).map((message) => ({
      ...cleanChatMessageForSave(message),
      id: crypto.randomUUID(),
      forkedFromMessageId: message.id,
    }));
    const id = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const title = `Fork: ${titleFromMessages(forkedMessages)}`;
    setActiveConversationId(id);
    setChatTitle(title);
    setChatSessionId(sessionId);
    setChatMessages(forkedMessages);
    setChatContents(messagesToContents(forkedMessages));
    setChatInput("");
    await saveChatConversation({ id, title, model: chatModel, sessionId, messages: forkedMessages, forkedFromId: activeConversationId });
  }

  async function editChatUserMessage(messageId, text) {
    const message = text.trim();
    if (!message || chatSending) return;
    const index = chatMessages.findIndex((entry) => entry.id === messageId);
    if (index < 0 || chatMessages[index].role !== "user") return;
    const baseMessages = chatMessages.slice(0, index).filter((entry) => !entry.loading);
    const userEntry = {
      ...cleanChatMessageForSave(chatMessages[index]),
      text: message,
      editedAt: new Date().toISOString(),
    };
    await sendChatMessage(message, { baseMessages, userEntry });
  }

  async function sendChatMessage(messageOverride, options = {}) {
    const message = (messageOverride ?? chatInput).trim();
    if (!message || chatSending) return;
    const conversationId = activeConversationId || crypto.randomUUID();
    const sessionId = chatSessionId || crypto.randomUUID();
    if (!activeConversationId) setActiveConversationId(conversationId);
    if (!chatSessionId) setChatSessionId(sessionId);
    const baseMessages = options.baseMessages || chatMessages.filter((entry) => !entry.loading);
    const userEntry = options.userEntry || { id: crypto.randomUUID(), role: "user", text: message, createdAt: new Date().toISOString() };
    const assistantId = crypto.randomUUID();
    const assistantEntry = { id: assistantId, role: "assistant", text: "", thought: "", model: chatModel, loading: true, createdAt: new Date().toISOString() };
    const requestMessages = [...baseMessages, userEntry];
    const optimisticMessages = [...requestMessages, assistantEntry];
    const nextContents = messagesToContents(requestMessages);
    setChatMessages(optimisticMessages);
    setChatContents(nextContents);
    setChatInput("");
    setChatSending(true);

    let fullText = "";
    let thoughtText = "";
    let actualModel = chatModel;

    try {
      const res = await fetch("/api/admin/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opengem-session-id": `admin-chat-${sessionId}`,
          ...csrfHeaders("POST"),
        },
        credentials: "same-origin",
        body: JSON.stringify({
          model: chatModel,
          contents: nextContents,
          generationConfig: { thinkingConfig: { includeThoughts: true } },
          systemInstruction: { parts: [{ text: systemPrompt }] },
        }),
      });
      if (res.status === 401) {
        setView("login");
        return;
      }
      if (!res.ok || !res.body) throw new Error("Chat request failed.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6);
          if (dataStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) throw new Error(parsed.error.message || "Model error.");
            if (parsed.openGemModelChange) {
              actualModel = parsed.openGemModelChange;
              continue;
            }
            const parts = parsed.candidates?.[0]?.content?.parts || parsed.response?.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.thought === true && part.text) thoughtText += part.text;
              else if (typeof part.thought === "string") thoughtText += part.thought;
              else if (part.text) fullText += part.text;
            }
            setChatMessages((prev) =>
              prev.map((entry) =>
                entry.id === assistantId
                  ? { ...entry, text: fullText, thought: thoughtText, model: actualModel, loading: false }
                  : entry
              )
            );
          } catch {
            // Incomplete chunks are ignored until the next line arrives.
          }
        }
      }
      const finalMessages = optimisticMessages.map((entry) =>
        entry.id === assistantId ? { ...entry, text: fullText || "No response text returned.", thought: thoughtText, model: actualModel, loading: false } : entry
      );
      const title = titleFromMessages(finalMessages);
      setChatTitle(title);
      setChatContents(messagesToContents(finalMessages));
      setChatMessages(finalMessages);
      await saveChatConversation({ id: conversationId, title, model: actualModel || chatModel, sessionId, messages: finalMessages });
    } catch (err) {
      const errorMessages = optimisticMessages.map((entry) =>
        entry.id === assistantId ? { ...entry, error: `Network error: ${err.message}`, loading: false } : entry
      );
      const title = titleFromMessages(errorMessages);
      setChatContents(messagesToContents(baseMessages));
      setChatMessages(errorMessages);
      setChatTitle(title);
      await saveChatConversation({ id: conversationId, title, model: chatModel, sessionId, messages: errorMessages });
    } finally {
      setChatSending(false);
    }
  }

  if (view === "checking") return <LoadingScreen />;
  if (view === "login") return <LoginScreen onLogin={() => setView("dashboard")} />;

  return (
    <TooltipProvider>
      <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
        <aside
          className="dashboard-sidebar relative z-20 border-b bg-card lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r"
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 px-4 py-4">
              <div className="flex size-10 items-center justify-center rounded-lg bg-background ring-1 ring-border">
                <InlineLogo />
              </div>
              <div>
                <div className="font-semibold">OpenGem</div>
                <div className="text-xs text-muted-foreground">Admin Console</div>
              </div>
            </div>
            <nav className="overflow-x-auto px-3 pb-3 lg:overflow-visible">
              <div className="flex gap-1 py-1.5 lg:flex-col lg:py-0">
              {PAGES.map((page) => {
                const Icon = page.icon;
                return (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => navigate(page.id)}
                    className={cn(
                      "flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      currentPage === page.id && "bg-primary/10 text-primary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_20%,transparent)]"
                    )}
                  >
                    <Icon data-icon="inline-start" />
                    {page.label}
                  </button>
                );
              })}
              </div>
            </nav>
            <div className="mt-auto hidden p-3 lg:block">
              <Button variant="ghost" className="w-full justify-start" onClick={logout}>
                <LogOut data-icon="inline-start" />
                Sign Out
              </Button>
            </div>
          </div>
        </aside>

        <main className="min-w-0">
          <div className="flex min-h-screen flex-col">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur md:px-6">
              <div className="flex min-w-0 items-center gap-2">
                <ActiveIcon data-icon="inline-start" />
                <span className="truncate text-sm font-medium text-muted-foreground">{activePage.label}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="hidden md:inline-flex">
                  <Radio data-icon="inline-start" />
                  {baseUrl.replace(/^https?:\/\//, "")}
                </Badge>
                <Button variant="ghost" size="sm" className="lg:hidden" onClick={logout}>
                  <LogOut data-icon="inline-start" />
                  Sign Out
                </Button>
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-5 p-4 pb-24 md:p-6 md:pb-24">
              {currentPage === "overview" ? (
                <OverviewPage stats={stats} loading={loading.stats} error={errors.stats} privacyMode={privacyMode} onRefresh={loadStats} />
              ) : null}
              {currentPage === "accounts" ? (
                <AccountsPage
                  accounts={accounts}
                  loading={loading.accounts}
                  error={errors.accounts}
                  privacyMode={privacyMode}
                  onRefresh={loadAccounts}
                  onDelete={deleteAccount}
                  onReactivate={reactivateAccount}
                />
              ) : null}
              {currentPage === "keys" ? (
                <KeysPage
                  keys={keys}
                  loading={loading.keys}
                  error={errors.keys}
                  newKeyName={newKeyName}
                  newKeyValue={newKeyValue}
                  setNewKeyName={setNewKeyName}
                  setNewKeyValue={setNewKeyValue}
                  onCreate={createKey}
                  onDelete={deleteKey}
                  onRefresh={loadKeys}
                />
              ) : null}
              {currentPage === "logs" ? (
                <LogsPage
                  logs={serverLogs}
                  loading={loading.logs}
                  error={errors.logs}
                  search={serverLogSearch}
                  setSearch={setServerLogSearch}
                  onRefresh={loadServerLogs}
                  onSelect={setSelectedServerLog}
                />
              ) : null}
              {currentPage === "requests" ? (
                <RequestsPage
                  logs={logs}
                  loading={loading.requests}
                  error={errors.requests}
                  privacyMode={privacyMode}
                  search={requestSearch}
                  setSearch={setRequestSearch}
                  onRefresh={loadRequests}
                  onSelect={setSelectedLog}
                />
              ) : null}
              {currentPage === "docs" ? (
                <DocsPage
                  baseUrl={baseUrl}
                  featureTab={featureTab}
                  setFeatureTab={setFeatureTab}
                  codeTab={codeTab}
                  setCodeTab={setCodeTab}
                  playground={playground}
                  setPlayground={setPlayground}
                  playgroundLoading={playgroundLoading}
                  onSendPlayground={sendPlayground}
                />
              ) : null}
              {currentPage === "chat" ? (
                <ChatPage
                  model={chatModel}
                  setModel={setChatModel}
                  input={chatInput}
                  setInput={setChatInput}
                  messages={chatMessages}
                  conversations={chatConversations}
                  activeConversationId={activeConversationId}
                  chatTitle={chatTitle}
                  historyLoading={chatHistoryLoading}
                  historyError={chatHistoryError}
                  sending={chatSending}
                  onSend={sendChatMessage}
                  onNew={startNewChat}
                  onLoadConversation={loadChatConversation}
                  onRefreshHistory={loadChatConversations}
                  onDeleteConversation={deleteChatConversation}
                  onForkMessage={forkChatFromMessage}
                  onEditMessage={editChatUserMessage}
                  scrollRef={chatScrollRef}
                />
              ) : null}
              {currentPage === "settings" ? (
                <SettingsPage
                  dbBackend={dbBackend}
                  dbLoading={loading.db}
                  dbError={errors.db}
                  onRefreshDb={loadDbStatus}
                  onSwitch={() => {
                    setDbSwitchError("");
                    setSwitchFirebase({});
                    setDbSwitchOpen(true);
                  }}
                  privacyMode={privacyMode}
                  setPrivacyMode={updatePrivacyMode}
                  credForm={credForm}
                  setCredForm={setCredForm}
                  credStatus={credStatus}
                  onUpdateCredentials={updateCredentials}
                  securitySettings={securitySettings}
                  securityLoading={loading.security}
                  securityError={errors.security}
                  securityStatus={securityStatus}
                  onSaveSecurity={saveSecuritySettings}
                  onRefreshSecurity={loadSecuritySettings}
                  onClearSmtp={clearSmtpSettings}
                  updateSmtpField={updateSmtpField}
                  updateLoggingField={updateLoggingField}
                  appearance={appearance}
                  setThemeMode={updateThemeMode}
                  setHighlightColor={updateHighlightColor}
                  resetHighlightColor={resetHighlightColor}
                />
              ) : null}
            </div>
          </div>
        </main>
      </div>

      <LogDetailDialog log={selectedLog} privacyMode={privacyMode} onOpenChange={(open) => !open && setSelectedLog(null)} />
      <ServerLogDetailDialog log={selectedServerLog} onOpenChange={(open) => !open && setSelectedServerLog(null)} />
      <DbSwitchDialog
        open={dbSwitchOpen}
        onOpenChange={setDbSwitchOpen}
        current={dbBackend}
        target={switchTarget}
        firebase={switchFirebase}
        setFirebase={setSwitchFirebase}
        error={dbSwitchError}
        loading={dbSwitchLoading}
        onPaste={pasteSwitchFirebase}
        onConfirm={confirmDbSwitch}
      />
      <ActionConfirmDialog
        action={confirmAction}
        loading={confirmActionLoading}
        error={confirmActionError}
        onOpenChange={(open) => {
          if (!open && !confirmActionLoading) {
            setConfirmAction(null);
            setConfirmActionError("");
          }
        }}
        onConfirm={confirmActionRequest}
      />
      <FirebaseConfigPasteDialog
        open={pasteConfigOpen}
        value={pasteConfigText}
        error={pasteConfigError}
        onValueChange={setPasteConfigText}
        onOpenChange={(open) => {
          setPasteConfigOpen(open);
          if (!open) {
            setPasteConfigText("");
            setPasteConfigError("");
          }
        }}
        onApply={() => applySwitchFirebaseText(pasteConfigText)}
      />
    </TooltipProvider>
  );
}

function OverviewPage({ stats, loading, error, privacyMode, onRefresh }) {
  const successRate = stats?.totalRequests ? Math.round((stats.successfulRequests / stats.totalRequests) * 100) : 0;
  return (
    <>
      <PageHeader title="Overview" description="API usage summary and account performance">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className={cn(loading && "animate-spin")} data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeader>
      <ErrorNotice>{error}</ErrorNotice>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Activity} label="Total Requests" value={loading ? "..." : formatNumber(stats?.totalRequests)} />
        <MetricCard icon={CheckCircle2} label="Success Rate" value={loading ? "..." : `${successRate}%`} tone="success" />
        <MetricCard icon={Users} label="Active Accounts" value={loading ? "..." : `${stats?.activeAccounts || 0} / ${stats?.totalAccounts || 0}`} tone="muted" />
        <MetricCard icon={Zap} label="Tokens Used" value={loading ? "..." : formatNumber(stats?.totalTokensUsed)} tone="warn" />
      </div>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Account Performance</CardTitle>
          <CardDescription>Per-account request, token and status totals.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Requests</TableHead>
                <TableHead>Success</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableEmpty colSpan={6}>Loading statistics...</TableEmpty> : null}
              {!loading && !stats?.accountStats?.length ? <TableEmpty colSpan={6}>No account data yet.</TableEmpty> : null}
              {!loading &&
                stats?.accountStats?.map((account) => (
                  <TableRow key={account.email}>
                    <TableCell className="font-mono text-xs">
                      {censorEmail(account.email, privacyMode)}
                      {account.isPro ? <Badge className="ml-2">PRO</Badge> : null}
                    </TableCell>
                    <TableCell>{formatNumber(account.totalRequests)}</TableCell>
                    <TableCell>{formatNumber(account.successfulRequests)}</TableCell>
                    <TableCell>{formatNumber(account.failedRequests)}</TableCell>
                    <TableCell>{formatNumber(account.totalTokensUsed)}</TableCell>
                    <TableCell><StatusBadge active={account.isActive} /></TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function AccountsPage({ accounts, loading, error, privacyMode, onRefresh, onDelete, onReactivate }) {
  return (
    <>
      <PageHeader title="Accounts" description="Connected Google accounts in the load-balanced rotation">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className={cn(loading && "animate-spin")} data-icon="inline-start" />
          Refresh
        </Button>
        <Button asChild size="sm">
          <a href="/api/auth/login">
            <ExternalLink data-icon="inline-start" />
            Connect Account
          </a>
        </Button>
      </PageHeader>
      <ErrorNotice>{error}</ErrorNotice>
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Project ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableEmpty colSpan={5}>Loading accounts...</TableEmpty> : null}
              {!loading && accounts.length === 0 ? <TableEmpty colSpan={5}>No accounts connected yet.</TableEmpty> : null}
              {!loading &&
                accounts.map((account) => (
                  <TableRow key={account.id || account.email}>
                    <TableCell className="font-mono text-xs">
                      {censorEmail(account.email, privacyMode)}
                      {account.isPro ? <Badge className="ml-2">PRO</Badge> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{account.projectId || "-"}</TableCell>
                    <TableCell><StatusBadge active={account.isActive} /></TableCell>
                    <TableCell className="text-muted-foreground">{formatTime(account.lastUsedAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {!account.isActive ? (
                          <Button variant="outline" size="sm" onClick={() => onReactivate(account.id || account.email)}>
                            <RotateCcw data-icon="inline-start" />
                            Reactivate
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => onDelete(account.id || account.email)} className="text-destructive hover:text-destructive">
                          <Trash2 data-icon="inline-start" />
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function KeysPage({ keys, loading, error, newKeyName, newKeyValue, setNewKeyName, setNewKeyValue, onCreate, onDelete, onRefresh }) {
  return (
    <>
      <PageHeader title="API Keys" description="Create and manage hashed gateway keys">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className={cn(loading && "animate-spin")} data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeader>
      <ErrorNotice>{error}</ErrorNotice>
      <Card>
        <CardHeader>
          <CardTitle>Create Key</CardTitle>
          <CardDescription>The full key is shown once after creation.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-center gap-3" onSubmit={onCreate}>
            <Input className="min-w-[200px] flex-1" value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} placeholder="e.g. Production, My App" />
            <Button type="submit" className="w-full sm:w-auto shrink-0">
              <Plus data-icon="inline-start" />
              Generate Key
            </Button>
          </form>
          {newKeyValue ? (
            <div className="mt-4 rounded-lg border bg-muted/45 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="success">Created</Badge>
                <span className="text-xs text-muted-foreground">Copy it now. It will not be shown again.</span>
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <code className="min-w-0 flex-1 break-all rounded-md bg-background px-3 py-2 text-xs">{newKeyValue}</code>
                <Button type="button" size="sm" onClick={() => copyText(newKeyValue)}>
                  <Copy data-icon="inline-start" />
                  Copy
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setNewKeyValue("")}>Dismiss</Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Requests</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableEmpty colSpan={5}>Loading API keys...</TableEmpty> : null}
              {!loading && keys.length === 0 ? <TableEmpty colSpan={5}>No API keys yet.</TableEmpty> : null}
              {!loading &&
                keys.map((key) => (
                  <TableRow key={key.id || key.name}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.key}</TableCell>
                    <TableCell className="text-muted-foreground">{formatTime(key.createdAt)}</TableCell>
                    <TableCell>{formatNumber(key.totalRequests)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(key.id, key.name)} className="text-destructive hover:text-destructive">
                        <Trash2 data-icon="inline-start" />
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input className="pl-9" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function LogsPage({ logs, loading, error, search, setSearch, onRefresh, onSelect }) {
  const filtered = filterLogs(logs, search);
  return (
    <>
      <PageHeader title="Logs" description="Incoming server API traffic, security-relevant status codes and redacted keys">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className={cn(loading && "animate-spin")} data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeader>
      <ErrorNotice>{error}</ErrorNotice>
      <LogTimelineChart logs={filtered} label="logs" />
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Server Logs</CardTitle>
              <CardDescription>{formatNumber(filtered.length)} matching entries</CardDescription>
            </div>
            <SearchBox value={search} onChange={setSearch} placeholder="Search logs..." />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request ID</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>User API</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Exec Time</TableHead>
                <TableHead>OpenGem Key</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableEmpty colSpan={9}>Loading logs...</TableEmpty> : null}
              {!loading && filtered.length === 0 ? <TableEmpty colSpan={9}>No logs match this search.</TableEmpty> : null}
              {!loading && filtered.map((log) => (
                <TableRow key={log.id} className="cursor-pointer" onClick={() => onSelect(log)}>
                  <TableCell className="font-mono text-xs">{String(log.id || "-").slice(0, 12)}</TableCell>
                  <TableCell><Badge variant={log.level === "error" ? "destructive" : log.level === "warn" ? "secondary" : "success"}>{log.level || "info"}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatTime(log.timestamp)}</TableCell>
                  <TableCell><Badge variant="outline">{log.method || "-"}</Badge></TableCell>
                  <TableCell className="max-w-[320px] truncate font-mono text-xs">{log.url || "-"}</TableCell>
                  <TableCell>{log.userApi || "-"}</TableCell>
                  <TableCell><Badge variant={statusBadgeVariant(log.status)}>{log.status || "-"}</Badge></TableCell>
                  <TableCell>{formatMs(log.execTimeMs)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{log.opengemKey || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function RequestsPage({ logs, loading, error, privacyMode, search, setSearch, onRefresh, onSelect }) {
  const filtered = filterLogs(logs, search);
  return (
    <>
      <PageHeader title="Requests" description="Gateway model calls, upstream account routing and token metadata">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className={cn(loading && "animate-spin")} data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeader>
      <ErrorNotice>{error}</ErrorNotice>
      <LogTimelineChart logs={filtered} label="requests" />
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Request History</CardTitle>
              <CardDescription>{formatNumber(filtered.length)} matching requests</CardDescription>
            </div>
            <SearchBox value={search} onChange={setSearch} placeholder="Search requests..." />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Question</TableHead>
                <TableHead>Answer</TableHead>
                <TableHead>Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableEmpty colSpan={7}>Loading requests...</TableEmpty> : null}
              {!loading && filtered.length === 0 ? <TableEmpty colSpan={7}>No requests match this search.</TableEmpty> : null}
              {!loading &&
                filtered.map((log, index) => {
                  const task = isTaskLog(log);
                  const sticky = Boolean(log.affinityKeyHash);
                  return (
                    <TableRow key={log.id || `${log.timestamp}-${index}`} className="cursor-pointer" onClick={() => onSelect(log)}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatTime(log.timestamp)}</TableCell>
                      <TableCell><Badge variant="outline">{log.method || "POST"}</Badge></TableCell>
                      <TableCell><Badge variant={statusBadgeVariant(log.status, log.success)}>{log.status || (log.success ? 200 : 502)}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">
                        {censorEmail(log.accountEmail, privacyMode)}
                        {task ? <Badge className="ml-2">Task</Badge> : null}
                        {sticky ? <Badge variant="outline" className="ml-2">Sticky</Badge> : null}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">{task ? "Automated Agent Task" : truncateText(log.question, 48)}</TableCell>
                      <TableCell className="max-w-[240px] truncate text-muted-foreground">
                        {!log.success ? <Badge variant="destructive" className="mr-2">Error</Badge> : null}
                        {truncateText(log.answer, 64)}
                      </TableCell>
                      <TableCell>
                        <div>{formatNumber(log.tokensUsed)}</div>
                        {log.isFallback ? <div className="mt-1 text-xs text-primary">Fallback</div> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function DocsPage({ baseUrl, featureTab, setFeatureTab, codeTab, setCodeTab, playground, setPlayground, playgroundLoading, onSendPlayground }) {
  return (
    <>
      <PageHeader title="API Documentation" description="Native Gemini, OpenAI, Responses, Anthropic and OpenRouter-style endpoints" />
      <div className="grid gap-3 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Base URL</CardTitle>
            <CardDescription>Use this origin in compatible SDKs.</CardDescription>
          </CardHeader>
          <CardContent><code className="break-all rounded-md bg-muted px-2 py-1 text-xs">{baseUrl}</code></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>One key works across all wire formats.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <code>Authorization: Bearer sk-your-api-key</code>
            <code>x-api-key / x-goog-api-key / ?key=</code>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
            <CardDescription>Per-IP safety limits and account rotation.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge variant="secondary">120 req/min</Badge>
            <Badge variant="secondary">5 logins / 15 min</Badge>
            <Badge variant="secondary">10 MB body default</Badge>
            <Badge variant="secondary">CSRF-bound admin session</Badge>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API Compatibility</CardTitle>
          <CardDescription>OpenGem translates requests to Gemini while preserving familiar client protocols.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 xl:grid-cols-4">
          {[
            { title: "Google Gemini", icon: geminiIcon.src, tag: "Native", auth: "Auth: x-goog-api-key / ?key=", rows: ["POST /v1beta/models/{model}:generateContent", "POST /v1beta/models/{model}:streamGenerateContent"] },
            { title: "OpenAI", icon: openaiIcon.src, tag: "Compatible", auth: "Auth: Authorization: Bearer", rows: ["POST /v1/responses", "POST /v1/chat/completions", "GET /v1/models"] },
            { title: "OpenRouter-style", icon: null, tag: "Router", auth: "Auth: Authorization: Bearer", rows: ["POST /api/v1/chat/completions", "POST /api/v1/responses", "GET /api/v1/models"] },
            { title: "Anthropic Claude", icon: claudeIcon.src, tag: "Compatible", auth: "Auth: x-api-key", rows: ["POST /v1/messages", "POST /api/v1/messages", "Stream: content_block_delta"] },
          ].map((provider) => (
            <div key={provider.title} className="min-w-0 rounded-lg border bg-background p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {provider.icon ? <img src={provider.icon} alt="" className="size-8 object-contain" /> : <Radio className="size-8 text-primary" />}
                  <div className="min-w-0">
                    <div className="font-semibold">{provider.title}</div>
                    <div className="break-words text-xs text-muted-foreground">{provider.auth}</div>
                  </div>
                </div>
                <Badge variant={provider.tag === "Native" ? "success" : "secondary"}>{provider.tag}</Badge>
              </div>
              <Separator className="my-4" />
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                {provider.rows.map((row) => <code key={row} className="block whitespace-normal break-all">{row}</code>)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Router Compatibility</CardTitle>
          <CardDescription>OpenRouter-style payloads are normalized before being routed through OpenGem.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 lg:grid-cols-4">
          {[
            ["Model Lists", "models[]", "Uses the first compatible model while preserving the requested id in responses."],
            ["Provider Hints", "provider", "Accepted for SDK compatibility without exposing provider internals."],
            ["Sticky Sessions", "session_id / x-session-id", "Pins related requests to one upstream account when possible."],
            ["Discovery", "supported_parameters", "Model list includes compatibility parameters for router-aware clients."],
          ].map(([title, header, detail]) => (
            <div key={title} className="min-w-0 rounded-lg border bg-background p-4">
              <div className="text-sm font-semibold">{title}</div>
              <code className="mt-2 block whitespace-normal break-all rounded-md bg-muted px-2 py-1 text-xs">{header}</code>
              <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account Affinity</CardTitle>
          <CardDescription>Keep multi-turn agent tasks on one upstream Google account while the balancer still fails over safely.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["Session", "x-opengem-session-id", "Use a stable thread or chat id."],
            ["Router", "x-session-id / session_id", "Use OpenRouter-compatible sticky routing keys."],
            ["Task", "x-opengem-task-id", "Use a stable automated task id."],
            ["User", "user / metadata.user_id", "SDK user fields also scope affinity."],
            ["Disable", "x-opengem-affinity: off", "Bypass sticky routing for one request."],
          ].map(([title, header, detail]) => (
            <div key={title} className="min-w-0 rounded-lg border bg-background p-4">
              <div className="text-sm font-semibold">{title}</div>
              <code className="mt-2 block whitespace-normal break-all rounded-md bg-muted px-2 py-1 text-xs">{header}</code>
              <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Admin Chat History</CardTitle>
          <CardDescription>Dashboard chats are stored behind the authenticated admin session for later continuation.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 lg:grid-cols-4">
          {[
            ["Resume", "GET /api/admin/chat/conversations", "Lists saved admin chat threads without exposing public API keys."],
            ["Persist", "PUT /api/admin/chat/conversations/{id}", "Stores bounded, validated message history for SQLite and Firestore backends."],
            ["Fork", "Message fork", "Creates a separate thread from any prior message while preserving the original."],
            ["Revise", "Edit and resend", "Editing a sent user turn truncates later turns and regenerates from that point."],
          ].map(([title, header, detail]) => (
            <div key={title} className="min-w-0 rounded-lg border bg-background p-4">
              <div className="text-sm font-semibold">{title}</div>
              <code className="mt-2 block whitespace-normal break-all rounded-md bg-muted px-2 py-1 text-xs">{header}</code>
              <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Adaptive Account Balancer</CardTitle>
          <CardDescription>OpenGem scores account health, local load, cooldown state and affinity before each upstream call.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 lg:grid-cols-4">
          {[
            ["Health", "Success streaks, failures and latency change account priority."],
            ["Load", "In-flight streams and local request windows are spread across accounts."],
            ["Recovery", "429 and Retry-After signals cool accounts down before probing again."],
            ["Tuning", "OPENGEM_* rate and concurrency variables adjust conservative defaults."],
          ].map(([title, detail]) => (
            <div key={title} className="min-w-0 rounded-lg border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Gauge className="size-4 text-primary" />
                {title}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>Features</CardTitle>
              <CardDescription>Streaming, system prompts, thinking traces and router payloads.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(featureSnippets).map(([id, item]) => (
                <Button key={id} type="button" size="sm" variant={featureTab === id ? "default" : "outline"} onClick={() => setFeatureTab(id)}>
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CodeBlock>{featureSnippets[featureTab].body}</CodeBlock>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>Code Examples</CardTitle>
              <CardDescription>Drop-in snippets for common SDKs.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(codeExamples).map(([id, item]) => (
                <Button key={id} type="button" size="sm" variant={codeTab === id ? "default" : "outline"} onClick={() => setCodeTab(id)}>
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CodeBlock>{codeExamples[codeTab].body(baseUrl)}</CodeBlock>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>API Playground</CardTitle>
            <CardDescription>Test a Gemini-format request from the dashboard.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input type="password" value={playground.apiKey} onChange={(event) => setPlayground((prev) => ({ ...prev, apiKey: event.target.value }))} placeholder="API key" />
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={playground.model}
              onChange={(event) => setPlayground((prev) => ({ ...prev, model: event.target.value }))}
            >
              {MODELS.map((model) => <option key={model}>{model}</option>)}
            </select>
            <Textarea value={playground.message} onChange={(event) => setPlayground((prev) => ({ ...prev, message: event.target.value }))} placeholder="Enter your prompt..." />
            <Button type="button" onClick={onSendPlayground} disabled={playgroundLoading}>
              {playgroundLoading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
              Send Request
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeBlock>{playground.response}</CodeBlock>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function CodeBlock({ children }) {
  return (
    <pre className="max-h-[520px] overflow-auto rounded-lg border bg-muted/55 p-4 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function ChatPage({
  model,
  setModel,
  input,
  setInput,
  messages,
  conversations,
  activeConversationId,
  chatTitle,
  historyLoading,
  historyError,
  sending,
  onSend,
  onNew,
  onLoadConversation,
  onRefreshHistory,
  onDeleteConversation,
  onForkMessage,
  onEditMessage,
  scrollRef,
}) {
  const suggestions = [
    "Explain how OpenGem proxies Gemini API requests.",
    "Write a short Python script that calls the Gemini API.",
    "Show me how to use streaming with OpenGem.",
    "Compare Gemini model aliases in this gateway.",
  ];
  return (
    <>
      <PageHeader title="Chat" description="Talk to Gemini through the authenticated admin gateway">
        <select
          className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {MODELS.slice(0, 5).map((item) => <option key={item}>{item}</option>)}
        </select>
        <Button variant="outline" size="sm" onClick={onNew}>
          <Plus data-icon="inline-start" />
          New Chat
        </Button>
      </PageHeader>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <ChatHistoryPanel
          conversations={conversations}
          activeConversationId={activeConversationId}
          loading={historyLoading}
          error={historyError}
          onNew={onNew}
          onRefresh={onRefreshHistory}
          onLoad={onLoadConversation}
          onDelete={onDeleteConversation}
        />
        <Card className="flex min-h-[calc(100vh-220px)] min-w-0 flex-1 flex-col overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle className="truncate text-base">{chatTitle || "New chat"}</CardTitle>
              <CardDescription>{messages.length ? `${messages.length} messages in this thread` : "A new admin chat thread is ready."}</CardDescription>
            </div>
          </CardHeader>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="mx-auto flex min-h-[360px] max-w-2xl flex-col items-center justify-center gap-4 text-center">
                <img src={geminiIcon.src} alt="Gemini" className="size-16 object-contain" />
                <div>
                  <h2 className="text-2xl font-semibold tracking-normal">How can I help you today?</h2>
                  <p className="mt-2 text-sm text-muted-foreground">Choose a model above and start chatting through OpenGem.</p>
                </div>
                <div className="grid w-full gap-2 sm:grid-cols-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => onSend(suggestion)}
                      className="rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-5">
                {messages.map((message) => (
                  <ChatBubble
                    key={message.id}
                    message={message}
                    requestedModel={model}
                    sending={sending}
                    onFork={onForkMessage}
                    onEdit={onEditMessage}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="border-t bg-gradient-to-b from-transparent to-muted/30 p-3 sm:p-4">
            <div className="mx-auto w-full max-w-3xl">
              <div className="flex flex-col gap-2 rounded-2xl border bg-background p-2 shadow-sm transition-all focus-within:border-primary/60 focus-within:shadow-md focus-within:ring-2 focus-within:ring-primary/15">
                <Textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      onSend();
                    }
                  }}
                  rows={1}
                  placeholder="Message Gemini…"
                  className="max-h-44 min-h-[2.75rem] w-full resize-none border-0 bg-transparent px-3 pt-2 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
                />
                <div className="flex items-center justify-between gap-2 pl-2 pr-1">
                  <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium">Enter</kbd>
                    to send
                    <kbd className="ml-1 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium">Shift</kbd>
                    +
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium">Enter</kbd>
                    for a new line
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    className="ml-auto h-9 gap-1.5 rounded-full px-4"
                    onClick={() => onSend()}
                    disabled={sending || !input.trim()}
                  >
                    {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    {sending ? "Sending" : "Send"}
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">Gemini can make mistakes. Check important info.</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

function ChatHistoryPanel({ conversations, activeConversationId, loading, error, onNew, onRefresh, onLoad, onDelete }) {
  return (
    <Card className="min-w-0 xl:sticky xl:top-20 xl:max-h-[calc(100vh-7rem)]">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <History data-icon="inline-start" />
              History
            </CardTitle>
            <CardDescription>Resume previous admin chats.</CardDescription>
          </div>
          <div className="flex gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onRefresh} disabled={loading}>
                  <RefreshCcw className={cn(loading && "animate-spin")} />
                  <span className="sr-only">Refresh history</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh history</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" className="size-8" onClick={onNew}>
                  <Plus />
                  <span className="sr-only">New chat</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>New chat</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex max-h-72 flex-col gap-2 overflow-y-auto xl:max-h-[calc(100vh-13rem)]">
        <ErrorNotice>{error}</ErrorNotice>
        {!loading && conversations.length === 0 ? (
          <div className="rounded-lg border bg-muted/45 px-3 py-4 text-sm text-muted-foreground">No saved chats yet.</div>
        ) : null}
        {conversations.map((conversation) => (
          <div key={conversation.id} className={cn("group rounded-lg border bg-background p-2", activeConversationId === conversation.id && "border-primary bg-primary/5")}>
            <button type="button" className="w-full min-w-0 text-left" onClick={() => onLoad(conversation.id)}>
              <div className="truncate text-sm font-medium">{conversation.title || "Untitled chat"}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{formatTime(conversation.updatedAt)}</span>
                <span>{conversation.messageCount || 0} messages</span>
              </div>
            </button>
            <div className="mt-2 flex items-center justify-between gap-2">
              <Badge variant={conversation.forkedFromId ? "outline" : "secondary"}>{conversation.forkedFromId ? "Fork" : conversation.model || DEFAULT_DASHBOARD_MODEL}</Badge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="size-8 opacity-80 group-hover:opacity-100" onClick={() => onDelete(conversation.id, conversation.title)}>
                    <Trash2 />
                    <span className="sr-only">Delete chat</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete chat</TooltipContent>
              </Tooltip>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ChatBubble({ message, requestedModel, sending, onFork, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text || "");

  useEffect(() => {
    setDraft(message.text || "");
    setEditing(false);
  }, [message.id, message.text]);

  if (message.role === "user") {
    return (
      <div className="ml-auto flex max-w-[88%] flex-col items-end gap-2">
        <div className="w-full rounded-3xl bg-primary px-4 py-3 text-sm text-primary-foreground">
          {editing ? (
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} className="min-h-24 rounded-2xl border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground placeholder:text-primary-foreground/70 focus-visible:ring-primary-foreground/40" />
          ) : (
            <div className="whitespace-pre-wrap break-words">{message.text}</div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {editing ? (
            <>
              <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(message.id, draft)} disabled={sending || !draft.trim()}>
                <Check data-icon="inline-start" />
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="ghost" onClick={() => copyText(message.text)}>
                <Copy data-icon="inline-start" />
                Copy
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={sending}>
                <Edit3 data-icon="inline-start" />
                Edit
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onFork(message.id)} disabled={sending}>
                <GitFork data-icon="inline-start" />
                Fork
              </Button>
            </>
          )}
        </div>
        {message.editedAt ? <div className="text-xs text-muted-foreground">Edited</div> : null}
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <img src={geminiIcon.src} alt="" className="mt-1 size-8 object-contain" />
      <div className="min-w-0 flex-1 rounded-lg border bg-background p-4">
        {message.loading && !message.text && !message.thought ? (
          <div className="flex gap-1 py-2">
            {[0, 1, 2].map((item) => (
              <span key={item} className="size-2 rounded-full bg-muted-foreground" style={{ animation: `soft-pulse 1.2s ${item * 0.15}s infinite` }} />
            ))}
          </div>
        ) : null}
        {message.thought ? (
          <details className="mb-3 rounded-lg border bg-muted/45 p-3 text-sm text-muted-foreground">
            <summary className="cursor-pointer font-medium">Thinking Process</summary>
            <div className="markdown-body mt-3" dangerouslySetInnerHTML={markdownHtml(message.thought)} />
          </details>
        ) : null}
        {message.error ? <ErrorNotice>{message.error}</ErrorNotice> : null}
        {message.text ? <div className="markdown-body text-sm" dangerouslySetInnerHTML={markdownHtml(message.text)} /> : null}
        {!message.loading ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Button variant="ghost" size="sm" onClick={() => copyText(message.text)}>
              <Copy data-icon="inline-start" />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onFork(message.id)} disabled={sending}>
              <GitFork data-icon="inline-start" />
              Fork
            </Button>
            <Badge variant="outline">
              {message.model || requestedModel}
              {message.model && message.model !== requestedModel ? " · Fallback" : ""}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SettingsPage({
  dbBackend,
  dbLoading,
  dbError,
  onRefreshDb,
  onSwitch,
  privacyMode,
  setPrivacyMode,
  credForm,
  setCredForm,
  credStatus,
  onUpdateCredentials,
  securitySettings,
  securityLoading,
  securityError,
  securityStatus,
  onSaveSecurity,
  onRefreshSecurity,
  onClearSmtp,
  updateSmtpField,
  updateLoggingField,
  appearance,
  setThemeMode,
  setHighlightColor,
  resetHighlightColor,
}) {
  const highlightColor = normalizeHexColor(appearance?.highlightColor);
  return (
    <>
      <PageHeader title="Settings" description="Interface, security and server configuration" />
      <ErrorNotice>{dbError}</ErrorNotice>
      <ErrorNotice>{securityError}</ErrorNotice>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Set the console theme and highlight color.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="grid gap-2 sm:grid-cols-3">
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <Button key={option.id} type="button" variant={appearance?.theme === option.id ? "default" : "outline"} onClick={() => setThemeMode(option.id)} className="justify-start">
                      <Icon data-icon="inline-start" />
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
                <label className="flex items-center gap-3 text-sm font-medium">
                  <span className="flex size-10 items-center justify-center rounded-md border bg-background">
                    <input type="color" value={highlightColor} onChange={(event) => setHighlightColor(event.target.value)} className="size-8 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Highlight color" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span>Highlight</span>
                    <code className="mt-1 text-xs text-muted-foreground">{highlightColor}</code>
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {HIGHLIGHT_PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use ${color}`}
                      onClick={() => setHighlightColor(color)}
                      className={cn("size-9 rounded-full border ring-offset-2 ring-offset-background transition", highlightColor === color && "ring-2 ring-ring")}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={resetHighlightColor}>
                    <Palette data-icon="inline-start" />
                    Reset
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Database Backend</CardTitle>
              <CardDescription>Switch between local SQLite and Firebase Firestore storage.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Current Backend</div>
                <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
                  <Database data-icon="inline-start" />
                  {dbLoading ? "Loading..." : dbBackend || "-"}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={onRefreshDb} disabled={dbLoading}>
                  <RefreshCcw className={cn(dbLoading && "animate-spin")} data-icon="inline-start" />
                  Refresh
                </Button>
                <Button onClick={onSwitch}>Switch Backend</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Log Retention</CardTitle>
              <CardDescription>Control how long Requests and Logs keep entries and whether IP addresses are stored.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-4" onSubmit={onSaveSecurity}>
                {[
                  ["requests", "Requests", "Gateway model request history"],
                  ["logs", "Logs", "Incoming server access logs"],
                ].map(([section, title, detail]) => (
                  <div key={section} className="rounded-lg border bg-background p-3">
                    <div className="mb-3 flex flex-col gap-1">
                      <div className="font-medium">{title}</div>
                      <div className="text-xs text-muted-foreground">{detail}</div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <label className="flex flex-col gap-2 text-sm font-medium">
                        Max Days Retention
                        <Input
                          type="number"
                          min="1"
                          max="365"
                          value={securitySettings?.logging?.[section]?.maxDaysRetention ?? 30}
                          onChange={(event) => updateLoggingField(section, "maxDaysRetention", event.target.value)}
                        />
                      </label>
                      <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={Boolean(securitySettings?.logging?.[section]?.enableIpLogging)}
                          onChange={(event) => updateLoggingField(section, "enableIpLogging", event.target.checked)}
                        />
                        Enable IP Logging
                      </label>
                    </div>
                  </div>
                ))}
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="min-h-5 text-sm text-muted-foreground">{securityStatus}</div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={onRefreshSecurity} disabled={securityLoading}>
                      <RefreshCcw className={cn(securityLoading && "animate-spin")} data-icon="inline-start" />
                      Refresh
                    </Button>
                    <Button type="submit" disabled={securityLoading}>
                      {securityLoading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
                      Save Security
                    </Button>
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Account Credentials</CardTitle>
              <CardDescription>Rotate the administrator username and password. You will be signed out after a successful change.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-3" onSubmit={onUpdateCredentials}>
                <Input type="password" placeholder="Current password" value={credForm.currentPassword} onChange={(event) => setCredForm((prev) => ({ ...prev, currentPassword: event.target.value }))} required />
                <Input placeholder="New username" value={credForm.newUsername} onChange={(event) => setCredForm((prev) => ({ ...prev, newUsername: event.target.value }))} required />
                <Input type="password" placeholder="New password" value={credForm.newPassword} onChange={(event) => setCredForm((prev) => ({ ...prev, newPassword: event.target.value }))} required />
                <Input type="password" placeholder="Confirm new password" value={credForm.confirmPassword} onChange={(event) => setCredForm((prev) => ({ ...prev, confirmPassword: event.target.value }))} required />
                <div className={cn("min-h-5 text-sm", credStatus.includes("updated") ? "text-accent-foreground" : "text-muted-foreground")}>{credStatus}</div>
                <Button type="submit">Update Credentials</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Email 2FA</CardTitle>
              <CardDescription>SMTP settings enable an email challenge after valid admin credentials.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-col gap-3" onSubmit={onSaveSecurity}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={securitySettings?.smtp?.configured ? "success" : "secondary"}>
                    <Mail data-icon="inline-start" />
                    {securitySettings?.smtp?.configured ? "Enabled" : "Disabled"}
                  </Badge>
                  {securitySettings?.smtp?.passwordSet ? <Badge variant="outline">Password stored</Badge> : null}
                </div>
                <Input placeholder="SMTP host" value={securitySettings?.smtp?.host || ""} onChange={(event) => updateSmtpField("host", event.target.value)} />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <Input type="number" min="1" max="65535" placeholder="Port" value={securitySettings?.smtp?.port || 587} onChange={(event) => updateSmtpField("port", event.target.value)} />
                  <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
                    <input type="checkbox" className="size-4 accent-primary" checked={Boolean(securitySettings?.smtp?.secure)} onChange={(event) => updateSmtpField("secure", event.target.checked)} />
                    TLS
                  </label>
                </div>
                <Input placeholder="SMTP username" value={securitySettings?.smtp?.username || ""} onChange={(event) => updateSmtpField("username", event.target.value)} autoComplete="username" />
                <Input
                  type="password"
                  placeholder={securitySettings?.smtp?.passwordSet ? "New SMTP password (blank keeps current)" : "SMTP password"}
                  value={securitySettings?.smtp?.password || ""}
                  onChange={(event) => updateSmtpField("password", event.target.value)}
                  autoComplete="new-password"
                />
                <Input placeholder="From email" value={securitySettings?.smtp?.fromEmail || ""} onChange={(event) => updateSmtpField("fromEmail", event.target.value)} />
                <Input placeholder="Recipient email" value={securitySettings?.smtp?.toEmail || ""} onChange={(event) => updateSmtpField("toEmail", event.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={securityLoading}>
                    {securityLoading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
                    Save 2FA
                  </Button>
                  <Button type="button" variant="outline" onClick={onClearSmtp} disabled={securityLoading || !securitySettings?.smtp?.configured}>
                    Disable
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Privacy Mode</CardTitle>
              <CardDescription>Censor email addresses for screen sharing and screenshots.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="rounded-lg bg-muted/55 px-3 py-2 text-sm">
                <code>example@gmail.com</code> <span className="text-muted-foreground">to</span> <code>e*****@gmail.com</code>
              </div>
              <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
                <input type="checkbox" className="size-4 accent-primary" checked={privacyMode} onChange={(event) => setPrivacyMode(event.target.checked)} />
                Email censoring
              </label>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function LogDetailDialog({ log, privacyMode, onOpenChange }) {
  const open = Boolean(log);
  const json = log ? JSON.stringify(log, null, 2) : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Request Detail</DialogTitle>
          <DialogDescription>Full prompt, response, routing and request metadata.</DialogDescription>
        </DialogHeader>
        {log ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => copyText(json)}>
                <Copy data-icon="inline-start" />
                Copy JSON
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Meta label="Time" value={formatDateTime(log.timestamp)} />
              {log.requestId ? <Meta label="Request ID" value={log.requestId} /> : null}
              {log.method ? <Meta label="Method" value={log.method} /> : null}
              {log.url ? <Meta label="URL" value={log.url} /> : null}
              {log.userApi ? <Meta label="User API" value={log.userApi} /> : null}
              {log.status !== undefined ? <Meta label="Status Code" value={log.status} /> : null}
              {log.execTimeMs !== undefined ? <Meta label="Exec Time" value={formatMs(log.execTimeMs)} /> : null}
              {log.opengemKey ? <Meta label="OpenGem Key" value={log.opengemKey} /> : null}
              {log.userAgent ? <Meta label="User Agent" value={log.userAgent} /> : null}
              {log.remoteIp ? <Meta label="Remote IP" value={log.remoteIp} /> : null}
              <Meta label="Account" value={censorEmail(log.accountEmail, privacyMode)} />
              <Meta label="Status" value={log.success ? "Success" : "Error"} />
              <Meta label="Tokens" value={formatNumber(log.tokensUsed)} />
              {log.effectiveTokensUsed !== undefined ? <Meta label="Effective Tokens" value={formatNumber(log.effectiveTokensUsed)} /> : null}
              {log.model ? <Meta label="Model" value={`${String(log.model).replace("models/", "")}${log.isFallback ? " · Fallback" : ""}`} /> : null}
              {log.affinitySource ? <Meta label="Affinity" value={`${log.affinitySource}${log.affinityHit ? " · Hit" : ""}${log.affinityRebound ? " · Rebound" : ""}`} /> : null}
              {log.affinityKeyHash ? <Meta label="Affinity Key" value={String(log.affinityKeyHash).slice(0, 16)} /> : null}
            </div>
            {log.systemInstruction ? <TextPanel title="System Prompt" text={log.systemInstruction} /> : null}
            <TextPanel title="Question" text={log.question || "-"} />
            <TextPanel title="Answer" text={log.answer || "-"} />
            <TextPanel title="JSON" text={json} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServerLogDetailDialog({ log, onOpenChange }) {
  const open = Boolean(log);
  const json = log ? JSON.stringify(log, null, 2) : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Log Detail</DialogTitle>
          <DialogDescription>Incoming request metadata with raw key material redacted.</DialogDescription>
        </DialogHeader>
        {log ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => copyText(json)}>
                <Copy data-icon="inline-start" />
                Copy JSON
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Meta label="Request ID" value={log.id} />
              <Meta label="Level" value={log.level} />
              <Meta label="Time" value={formatDateTime(log.timestamp)} />
              <Meta label="Method" value={log.method} />
              <Meta label="URL" value={log.url} />
              <Meta label="User API" value={log.userApi} />
              <Meta label="Status" value={log.status} />
              <Meta label="Exec Time" value={formatMs(log.execTimeMs)} />
              <Meta label="OpenGem Key" value={log.opengemKey || "-"} />
              <Meta label="User Agent" value={log.userAgent || "-"} />
              <Meta label="Remote IP" value={log.remoteIp || "-"} />
              <Meta label="Response Size" value={log.responseSize || "-"} />
            </div>
            <TextPanel title="JSON" text={json} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm">{value || "-"}</div>
    </div>
  );
}

function TextPanel({ title, text }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase text-muted-foreground">{title}</div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={`Copy ${title}`} onClick={() => copyText(text)}>
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy {title}</TooltipContent>
        </Tooltip>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
    </div>
  );
}

function ActionConfirmDialog({ action, loading, error, onOpenChange, onConfirm }) {
  const open = Boolean(action);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{action?.title || "Confirm Action"}</DialogTitle>
          <DialogDescription>{action?.description || "Confirm this action to continue."}</DialogDescription>
        </DialogHeader>
        <ErrorNotice>{error}</ErrorNotice>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
          <Button type="button" variant={action?.destructive ? "destructive" : "default"} onClick={onConfirm} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
            {action?.confirmLabel || "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FirebaseConfigPasteDialog({ open, value, error, onValueChange, onOpenChange, onApply }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Paste Firebase Config</DialogTitle>
          <DialogDescription>Paste the Firebase Web app config JSON and OpenGem will fill the fields.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "..." }'
          className="min-h-40 font-mono text-xs"
        />
        <ErrorNotice>{error}</ErrorNotice>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={onApply}>
            <Clipboard data-icon="inline-start" />
            Apply Config
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DbSwitchDialog({ open, onOpenChange, current, target, firebase, setFirebase, error, loading, onPaste, onConfirm }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Switch Database Backend</DialogTitle>
          <DialogDescription>
            Switching from {current || "-"} to {target || "-"}. Accounts and logs will be migrated automatically; API keys need regeneration.
          </DialogDescription>
        </DialogHeader>
        {target === "firebase" ? (
          <div className="grid gap-3 md:grid-cols-2">
            {firebaseFields.map(([key, label, placeholder]) => (
              <label key={key} className={cn("flex flex-col gap-2 text-sm font-medium", key === "measurementId" && "md:col-span-2")}>
                {label}{key === "measurementId" ? <span className="font-normal text-muted-foreground"> optional</span> : null}
                <Input value={firebase[key] || ""} onChange={(event) => setFirebase((prev) => ({ ...prev, [key]: event.target.value }))} placeholder={placeholder} />
              </label>
            ))}
            <div className="md:col-span-2">
              <Button type="button" variant="outline" onClick={onPaste}>
                <Clipboard data-icon="inline-start" />
                Paste Firebase Config JSON
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/45 p-4 text-sm text-muted-foreground">
            OpenGem will store data in <code>data/db.sqlite</code> using Node.js built-in SQLite support.
          </div>
        )}
        <ErrorNotice>{error}</ErrorNotice>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={onConfirm} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Database data-icon="inline-start" />}
            Confirm Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
