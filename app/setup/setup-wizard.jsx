"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Database,
  HardDrive,
  Loader2,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { FirebaseConfigPasteDialog, parseFirebaseText } from "../opengem-console";
import logoBlack from "../assets/logo-black.png";
import firebaseIcon from "../assets/firebase.png";

const fields = [
  ["apiKey", "API Key", "AIzaSy..."],
  ["authDomain", "Auth Domain", "your-app.firebaseapp.com"],
  ["projectId", "Project ID", "your-project-id"],
  ["storageBucket", "Storage Bucket", "your-app.appspot.com"],
  ["messagingSenderId", "Messaging Sender ID", "123456789"],
  ["appId", "App ID", "1:123456:web:abc123"],
  ["measurementId", "Measurement ID", "G-XXXXXXXXXX"],
];

function InlineLogo() {
  return <img src={logoBlack.src} alt="OpenGem" className="size-12 object-contain" />;
}

function SetupError({ children }) {
  if (!children) return null;
  return <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">{children}</div>;
}

export function SetupWizard() {
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState(1);
  const [backend, setBackend] = useState("local");
  const [firebase, setFirebase] = useState({});
  const [admin, setAdmin] = useState({ username: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pasteConfigOpen, setPasteConfigOpen] = useState(false);
  const [pasteConfigText, setPasteConfigText] = useState("");
  const [pasteConfigError, setPasteConfigError] = useState("");

  const stepLabels = useMemo(() => ["Backend", backend === "firebase" ? "Firebase" : "Local DB", "Admin", "Complete"], [backend]);

  useEffect(() => {
    async function check() {
      try {
        const res = await fetch("/api/setup/status");
        const data = await res.json();
        if (data.configured) {
          window.location.href = "/";
          return;
        }
      } catch {
        // Setup should still render if status check fails.
      }
      setChecking(false);
    }
    check();
  }, []);

  function showStep(nextStep) {
    setError("");
    setStep(nextStep);
  }

  function validateFirebase() {
    const missing = fields
      .filter(([key]) => key !== "measurementId")
      .filter(([key]) => !String(firebase[key] || "").trim());
    if (missing.length) {
      setError("Please fill in all required Firebase fields.");
      return false;
    }
    return true;
  }

  function goStep2() {
    showStep(2);
  }

  function goStep3() {
    if (backend === "firebase" && !validateFirebase()) return;
    showStep(3);
  }

  function pasteFirebase() {
    setError("");
    setPasteConfigText("");
    setPasteConfigError("");
    setPasteConfigOpen(true);
  }

  function applyFirebasePaste(text) {
    const parsed = parseFirebaseText(text);
    if (!parsed) {
      setPasteConfigError("Could not parse Firebase config. Please paste a valid JSON object.");
      return;
    }
    setFirebase((prev) => ({ ...prev, ...parsed }));
    setPasteConfigOpen(false);
    setPasteConfigText("");
    setPasteConfigError("");
  }

  async function completeSetup() {
    setError("");
    if (!admin.username.trim()) {
      setError("Please enter an admin username.");
      return;
    }
    if (!admin.password || admin.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!/[A-Z]/.test(admin.password) || !/[a-z]/.test(admin.password) || !/[0-9]/.test(admin.password)) {
      setError("Password must contain at least one uppercase letter, one lowercase letter, and one digit.");
      return;
    }
    if (admin.password !== admin.confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        dbBackend: backend,
        admin: { username: admin.username.trim(), password: admin.password },
      };
      if (backend === "firebase") {
        body.firebase = Object.fromEntries(fields.map(([key]) => [key, String(firebase[key] || "").trim()]));
      }
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Setup failed.");
      showStep(4);
    } catch (err) {
      setError(err.message || "Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
          <Loader2 className="animate-spin" data-icon="inline-start" />
          Checking setup status...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex size-16 items-center justify-center rounded-xl border bg-card shadow-sm">
              <InlineLogo />
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-normal">OpenGem</h1>
              <p className="text-sm text-muted-foreground">Configure your self-hosted AI gateway in minutes.</p>
            </div>
          </div>
          <Badge variant="secondary" className="w-fit">
            <ShieldCheck data-icon="inline-start" />
            Secure by default
          </Badge>
        </header>

        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-4 gap-2">
              {stepLabels.map((label, index) => {
                const number = index + 1;
                const active = step === number;
                const complete = step > number;
                return (
                  <div key={label} className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
                        active && "border-primary bg-primary text-primary-foreground",
                        complete && "border-accent bg-accent text-accent-foreground"
                      )}
                    >
                      {complete ? <CheckCircle2 /> : number}
                    </div>
                    <span className={cn("hidden text-sm font-medium text-muted-foreground sm:inline", active && "text-foreground")}>{label}</span>
                    {number < 4 ? <Separator className="hidden flex-1 md:block" /> : null}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <SetupError>{error}</SetupError>

        {step === 1 ? (
          <Card>
            <CardHeader>
              <CardTitle>Choose Database Backend</CardTitle>
              <CardDescription>Select where OpenGem stores accounts, API keys and logs. You can switch later from Settings.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <BackendCard
                  selected={backend === "local"}
                  onClick={() => setBackend("local")}
                  icon={HardDrive}
                  title="Local SQLite"
                  badge="Recommended"
                  description="Stored in data/db.sqlite on the server using Node.js built-in SQLite support. No external service required."
                />
                <BackendCard
                  selected={backend === "firebase"}
                  onClick={() => setBackend("firebase")}
                  image={firebaseIcon.src}
                  title="Firebase Firestore"
                  description="Uses Google Firebase for cloud storage. Requires a Firebase project configuration."
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={goStep2}>
                  Continue
                  <ChevronRight data-icon="inline-end" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {step === 2 && backend === "local" ? (
          <Card>
            <CardHeader>
              <CardTitle>Local Database Confirmed</CardTitle>
              <CardDescription>OpenGem will keep all data on this server in the SQLite database.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  "Tokens are AES-256-GCM encrypted at rest",
                  "API keys are stored as SHA-256 hashes",
                  "Logs are capped at 5,000 entries automatically",
                  "Back up data/db.sqlite periodically",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3 rounded-lg border bg-background p-3 text-sm">
                    <CheckCircle2 className="text-accent-foreground" data-icon="inline-start" />
                    {item}
                  </div>
                ))}
              </div>
              <WizardActions back={() => showStep(1)} next={goStep3} />
            </CardContent>
          </Card>
        ) : null}

        {step === 2 && backend === "firebase" ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <img src={firebaseIcon.src} alt="" className="size-6 object-contain" />
                Firebase Configuration
              </CardTitle>
              <CardDescription>Paste or type the Firebase Web app config from Project Settings.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                {fields.map(([key, label, placeholder]) => (
                  <label key={key} className={cn("flex flex-col gap-2 text-sm font-medium", key === "measurementId" && "md:col-span-2")}>
                    {label}{key === "measurementId" ? <span className="font-normal text-muted-foreground"> optional</span> : null}
                    <Input value={firebase[key] || ""} onChange={(event) => setFirebase((prev) => ({ ...prev, [key]: event.target.value }))} placeholder={placeholder} />
                  </label>
                ))}
              </div>
              <div>
                <Button type="button" variant="outline" onClick={pasteFirebase}>
                  <Clipboard data-icon="inline-start" />
                  Paste Firebase Config JSON
                </Button>
              </div>
              <WizardActions back={() => showStep(1)} next={goStep3} />
            </CardContent>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card>
            <CardHeader>
              <CardTitle>Admin Account</CardTitle>
              <CardDescription>Create credentials for dashboard access.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm font-medium md:col-span-2">
                  Username
                  <Input value={admin.username} onChange={(event) => setAdmin((prev) => ({ ...prev, username: event.target.value }))} placeholder="admin" autoComplete="username" />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Password
                  <Input type="password" value={admin.password} onChange={(event) => setAdmin((prev) => ({ ...prev, password: event.target.value }))} placeholder="Min 8 characters" autoComplete="new-password" />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Confirm Password
                  <Input type="password" value={admin.confirm} onChange={(event) => setAdmin((prev) => ({ ...prev, confirm: event.target.value }))} placeholder="Repeat password" autoComplete="new-password" />
                </label>
              </div>
              <div className="rounded-lg border bg-muted/45 p-3 text-sm text-muted-foreground">
                Password must contain at least one uppercase letter, one lowercase letter and one digit.
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button type="button" variant="outline" onClick={() => showStep(2)}>
                  <ChevronLeft data-icon="inline-start" />
                  Back
                </Button>
                <Button type="button" onClick={completeSetup} disabled={submitting}>
                  {submitting ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <CheckCircle2 data-icon="inline-start" />}
                  Complete Setup
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {step === 4 ? (
          <Card>
            <CardHeader className="items-center text-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <CheckCircle2 />
              </div>
              <CardTitle>Setup Complete</CardTitle>
              <CardDescription>OpenGem is configured and ready. Sign in to connect accounts and create API keys.</CardDescription>
            </CardHeader>
            <CardContent className="flex justify-center">
              <Button asChild>
                <a href="/">
                  Open Dashboard
                  <ChevronRight data-icon="inline-end" />
                </a>
              </Button>
            </CardContent>
          </Card>
        ) : null}
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
          onApply={() => applyFirebasePaste(pasteConfigText)}
        />
      </div>
    </main>
  );
}

function BackendCard({ selected, onClick, icon: Icon, image, title, description, badge }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex min-h-44 flex-col gap-4 rounded-lg border bg-background p-4 text-left transition-colors hover:bg-muted/45",
        selected && "border-primary bg-primary/5 ring-2 ring-primary/20"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-11 items-center justify-center rounded-lg bg-card ring-1 ring-border">
          {image ? <img src={image} alt="" className="size-8 object-contain" /> : <Icon />}
        </div>
        {selected ? <CheckCircle2 className="text-primary" /> : null}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{title}</span>
          {badge ? <Badge variant="success">{badge}</Badge> : null}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function WizardActions({ back, next }) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
      <Button type="button" variant="outline" onClick={back}>
        <ChevronLeft data-icon="inline-start" />
        Back
      </Button>
      <Button type="button" onClick={next}>
        Continue
        <ChevronRight data-icon="inline-end" />
      </Button>
    </div>
  );
}
