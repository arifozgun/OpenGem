"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import {
  Activity,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Clipboard,
  Copy,
  Database,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  MonitorSmartphone,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
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
  { id: "logs", label: "Request Logs", icon: Activity },
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

function markdownHtml(text) {
  return { __html: marked.parse(text || "") };
}

function InlineLogo({ className }) {
  return (
    <img
      src={logoBlack.src}
      alt="OpenGem"
      className={cn("size-8 object-contain", className)}
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

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Invalid credentials or rate limit exceeded.");
      setUsername("");
      setPassword("");
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
          <CardDescription>Sign in to your admin dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
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
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <LogIn data-icon="inline-start" />}
              Sign In
            </Button>
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
  const [privacyMode, setPrivacyMode] = useState(false);
  const [stats, setStats] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [keys, setKeys] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [selectedLog, setSelectedLog] = useState(null);
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
  const [playground, setPlayground] = useState({ apiKey: "", model: DEFAULT_DASHBOARD_MODEL, message: "", response: "Awaiting response..." });
  const [playgroundLoading, setPlaygroundLoading] = useState(false);
  const [featureTab, setFeatureTab] = useState("streaming");
  const [codeTab, setCodeTab] = useState("curl");
  const [chatModel, setChatModel] = useState(DEFAULT_DASHBOARD_MODEL);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatContents, setChatContents] = useState([]);
  const [chatSending, setChatSending] = useState(false);
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
      throw new Error(data.error || "Request failed.");
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

  const loadLogs = useCallback(async () => {
    setLoadingKey("logs", true);
    setErrorKey("logs", "");
    try {
      setLogs(await requestJson("/api/logs?limit=500"));
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

  useEffect(() => {
    if (view !== "dashboard") return;
    if (currentPage === "overview") loadStats();
    if (currentPage === "accounts") loadAccounts();
    if (currentPage === "keys") loadKeys();
    if (currentPage === "logs") loadLogs();
    if (currentPage === "settings") loadDbStatus();
  }, [currentPage, loadAccounts, loadDbStatus, loadKeys, loadLogs, loadStats, view]);

  function navigate(pageId) {
    setCurrentPage(pageId);
    const path = pageId === "overview" ? "/" : `/${pageId}`;
    if (window.location.pathname !== path) {
      window.history.pushState({ page: pageId }, "", path);
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    setView("login");
  }

  function updatePrivacyMode(enabled) {
    setPrivacyMode(enabled);
    localStorage.setItem("privacyMode", String(enabled));
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

  async function sendChatMessage(messageOverride) {
    const message = (messageOverride ?? chatInput).trim();
    if (!message || chatSending) return;
    const userEntry = { id: crypto.randomUUID(), role: "user", text: message };
    const assistantId = crypto.randomUUID();
    const assistantEntry = { id: assistantId, role: "assistant", text: "", thought: "", model: chatModel, loading: true };
    const nextContents = [...chatContents, { role: "user", parts: [{ text: message }] }];
    setChatMessages((prev) => [...prev, userEntry, assistantEntry]);
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
          "x-opengem-session-id": `admin-chat-${chatSessionId}`,
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
      setChatContents([...nextContents, { role: "model", parts: [{ text: fullText }] }]);
      setChatMessages((prev) =>
        prev.map((entry) =>
          entry.id === assistantId ? { ...entry, text: fullText || "No response text returned.", thought: thoughtText, model: actualModel, loading: false } : entry
        )
      );
    } catch (err) {
      setChatContents(chatContents);
      setChatMessages((prev) =>
        prev.map((entry) =>
          entry.id === assistantId ? { ...entry, error: `Network error: ${err.message}`, loading: false } : entry
        )
      );
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

            <div className="flex flex-1 flex-col gap-5 p-4 md:p-6">
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
                  logs={logs}
                  loading={loading.logs}
                  error={errors.logs}
                  privacyMode={privacyMode}
                  onRefresh={loadLogs}
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
                  sending={chatSending}
                  onSend={sendChatMessage}
                  onNew={() => {
                    setChatMessages([]);
                    setChatContents([]);
                    setChatInput("");
                    setChatSessionId(crypto.randomUUID());
                    setChatModel(DEFAULT_DASHBOARD_MODEL);
                  }}
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
                />
              ) : null}
            </div>
          </div>
        </main>
      </div>

      <LogDetailDialog log={selectedLog} privacyMode={privacyMode} onOpenChange={(open) => !open && setSelectedLog(null)} />
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
          <form className="flex flex-col gap-3 md:flex-row" onSubmit={onCreate}>
            <Input value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} placeholder="e.g. Production, My App" />
            <Button type="submit" className="md:w-auto">
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

function LogsPage({ logs, loading, error, privacyMode, onRefresh, onSelect }) {
  return (
    <>
      <PageHeader title="Request Logs" description="Recent gateway calls, responses and fallback markers">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className={cn(loading && "animate-spin")} data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeader>
      <ErrorNotice>{error}</ErrorNotice>
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Question</TableHead>
                <TableHead>Answer</TableHead>
                <TableHead>Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? <TableEmpty colSpan={5}>Loading logs...</TableEmpty> : null}
              {!loading && logs.length === 0 ? <TableEmpty colSpan={5}>No request logs yet.</TableEmpty> : null}
              {!loading &&
                logs.map((log, index) => {
                  const task = isTaskLog(log);
                  const sticky = Boolean(log.affinityKeyHash);
                  return (
                    <TableRow key={log.id || `${log.timestamp}-${index}`} className="cursor-pointer" onClick={() => onSelect(log)}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatTime(log.timestamp)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {censorEmail(log.accountEmail, privacyMode)}
                        {task ? <Badge className="ml-2">Task</Badge> : null}
                        {sticky ? <Badge variant="outline" className="ml-2">Sticky</Badge> : null}
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate">{task ? "Automated Agent Task" : log.question || "-"}</TableCell>
                      <TableCell className="max-w-[360px] truncate">
                        {!log.success ? <Badge variant="destructive" className="mr-2">Error</Badge> : null}
                        {log.answer || "-"}
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
      <PageHeader title="API Documentation" description="Native Gemini, OpenAI and Anthropic compatible endpoints" />
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
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API Compatibility</CardTitle>
          <CardDescription>OpenGem translates requests to Gemini while preserving familiar client protocols.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 lg:grid-cols-3">
          {[
            { title: "Google Gemini", icon: geminiIcon.src, tag: "Native", rows: ["POST /v1beta/models/{model}:generateContent", "POST /v1beta/models/{model}:streamGenerateContent", "Auth: x-goog-api-key / ?key="] },
            { title: "OpenAI", icon: openaiIcon.src, tag: "Compatible", rows: ["POST /v1/chat/completions", "GET /v1/models", "Auth: Authorization: Bearer"] },
            { title: "Anthropic Claude", icon: claudeIcon.src, tag: "Compatible", rows: ["POST /v1/messages", "Stream: content_block_delta", "Auth: x-api-key"] },
          ].map((provider) => (
            <div key={provider.title} className="min-w-0 rounded-lg border bg-background p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <img src={provider.icon} alt="" className="size-8 object-contain" />
                  <div className="min-w-0">
                    <div className="font-semibold">{provider.title}</div>
                    <div className="break-words text-xs text-muted-foreground">{provider.rows[2]}</div>
                  </div>
                </div>
                <Badge variant={provider.tag === "Native" ? "success" : "secondary"}>{provider.tag}</Badge>
              </div>
              <Separator className="my-4" />
              <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                {provider.rows.slice(0, 2).map((row) => <code key={row} className="block whitespace-normal break-all">{row}</code>)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account Affinity</CardTitle>
          <CardDescription>Keep multi-turn agent tasks on one upstream Google account for better context continuity.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 lg:grid-cols-3">
          {[
            ["Session", "x-opengem-session-id", "Use a stable thread or chat id."],
            ["Task", "x-opengem-task-id", "Use a stable automated task id."],
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
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>Features</CardTitle>
              <CardDescription>Streaming, system prompts and thinking traces.</CardDescription>
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

function ChatPage({ model, setModel, input, setInput, messages, sending, onSend, onNew, scrollRef }) {
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
      <Card className="flex min-h-[calc(100vh-190px)] flex-1 flex-col overflow-hidden">
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
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {messages.map((message) => (
                <ChatBubble key={message.id} message={message} requestedModel={model} />
              ))}
            </div>
          )}
        </div>
        <div className="border-t bg-card p-3">
          <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-lg border bg-background p-2">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
              placeholder="Message Gemini..."
              className="max-h-36 min-h-10 border-0 shadow-none focus-visible:ring-0"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" onClick={() => onSend()} disabled={sending || !input.trim()}>
                  {sending ? <Loader2 className="animate-spin" /> : <Send />}
                  <span className="sr-only">Send</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send message</TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">Gemini can make mistakes. Check important info.</p>
        </div>
      </Card>
    </>
  );
}

function ChatBubble({ message, requestedModel }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[82%] rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground">
        {message.text}
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

function SettingsPage({ dbBackend, dbLoading, dbError, onRefreshDb, onSwitch, privacyMode, setPrivacyMode, credForm, setCredForm, credStatus, onUpdateCredentials }) {
  return (
    <>
      <PageHeader title="Settings" description="Server configuration, database management and API compatibility" />
      <ErrorNotice>{dbError}</ErrorNotice>
      <Card>
        <CardHeader>
          <CardTitle>API Compatibility</CardTitle>
          <CardDescription>Three live wire formats share the same hashed API key store.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 lg:grid-cols-3">
          {[
            ["Gemini", geminiIcon.src, "POST /v1beta/models/{model}:generateContent"],
            ["OpenAI", openaiIcon.src, "POST /v1/chat/completions · GET /v1/models"],
            ["Anthropic Claude", claudeIcon.src, "POST /v1/messages"],
          ].map(([title, icon, endpoint]) => (
            <div key={title} className="flex min-w-0 items-center gap-3 rounded-lg border bg-background p-3">
              <img src={icon} alt="" className="size-8 object-contain" />
              <div className="min-w-0">
                <div className="font-medium">{title}</div>
                <code className="block whitespace-normal break-all text-xs text-muted-foreground">{endpoint}</code>
              </div>
            </div>
          ))}
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
          <CardTitle>Account Credentials</CardTitle>
          <CardDescription>Rotate the administrator username and password. You will be signed out after a successful change.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-2" onSubmit={onUpdateCredentials}>
            <Input type="password" placeholder="Current password" value={credForm.currentPassword} onChange={(event) => setCredForm((prev) => ({ ...prev, currentPassword: event.target.value }))} required />
            <Input placeholder="New username" value={credForm.newUsername} onChange={(event) => setCredForm((prev) => ({ ...prev, newUsername: event.target.value }))} required />
            <Input type="password" placeholder="New password" value={credForm.newPassword} onChange={(event) => setCredForm((prev) => ({ ...prev, newPassword: event.target.value }))} required />
            <Input type="password" placeholder="Confirm new password" value={credForm.confirmPassword} onChange={(event) => setCredForm((prev) => ({ ...prev, confirmPassword: event.target.value }))} required />
            <div className="flex flex-col gap-2 md:col-span-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
              <div className={cn("min-h-5 text-sm", credStatus.includes("updated") ? "text-accent-foreground" : "text-muted-foreground")}>{credStatus}</div>
              <Button type="submit">Update Credentials</Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Privacy Mode</CardTitle>
          <CardDescription>Censor email addresses for screen sharing and screenshots.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="rounded-lg bg-muted/55 px-3 py-2 text-sm">
            <code>example@gmail.com</code> <span className="text-muted-foreground">to</span> <code>e*****@gmail.com</code>
          </div>
          <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
            <input type="checkbox" className="size-4 accent-primary" checked={privacyMode} onChange={(event) => setPrivacyMode(event.target.checked)} />
            Email censoring
          </label>
        </CardContent>
      </Card>
    </>
  );
}

function LogDetailDialog({ log, privacyMode, onOpenChange }) {
  const open = Boolean(log);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto" onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Request Log Detail</DialogTitle>
          <DialogDescription>Full prompt, response, model and token metadata.</DialogDescription>
        </DialogHeader>
        {log ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Meta label="Time" value={new Date(log.timestamp).toLocaleString("en-US")} />
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
