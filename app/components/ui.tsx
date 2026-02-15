"use client";

import * as React from "react";

function cx(...classes: Array<string | undefined | false | null>) {
  return classes.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("glass glass-rim glass-noise", className)} style={{ borderRadius: 18, padding: 18 }}>
      {children}
    </div>
  );
}

type ButtonVariant = "primary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  className?: string;
}) {
  const base =
    "ring-violet-hover " +
    "inline-flex items-center justify-center gap-8px " +
    "rounded-xl px-4 py-2 text-sm font-semibold";

  const style: React.CSSProperties = {
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 800,
    letterSpacing: 0.2,
    cursor: props.disabled ? "not-allowed" : "pointer",
    opacity: props.disabled ? 0.6 : 1,
  };

  const primary: React.CSSProperties = {
    background: "white",
    color: "#09090b",
    border: "1px solid rgba(255,255,255,.10)",
    boxShadow: "0 16px 50px rgba(0,0,0,0.55)",
  };

  const ghost: React.CSSProperties = {
    background: "rgba(255,255,255,.06)",
    color: "rgba(255,255,255,.92)",
    border: "1px solid rgba(255,255,255,.10)",
    boxShadow: "0 10px 30px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04) inset",
    backdropFilter: "blur(10px)",
  };

  const danger: React.CSSProperties = {
    background: "rgba(239,68,68,.15)",
    color: "rgba(255,255,255,.92)",
    border: "1px solid rgba(239,68,68,.30)",
    boxShadow: "0 16px 50px rgba(0,0,0,0.55)",
  };

  const picked = variant === "primary" ? primary : variant === "danger" ? danger : ghost;

  return (
    <button className={cx(base, className)} style={{ ...style, ...picked }} {...props}>
      {children}
    </button>
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      {...props}
      className={cx(className)}
      style={{
        width: "100%",
        borderRadius: 12,
        padding: "10px 12px",
        border: "1px solid rgba(255,255,255,.10)",
        background: "rgba(255,255,255,.05)",
        color: "rgba(255,255,255,.92)",
        outline: "none",
        boxShadow: "0 0 0 1px rgba(255,255,255,.04) inset",
        backdropFilter: "blur(10px)",
      }}
    />
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "purple" | "green";
}) {
  const toneStyle: React.CSSProperties =
    tone === "purple"
      ? {
          border: "1px solid rgba(168,85,247,.25)",
          background: "rgba(168,85,247,.10)",
          color: "rgba(232, 226, 255, .95)",
        }
      : tone === "green"
      ? {
          border: "1px solid rgba(34,197,94,.25)",
          background: "rgba(34,197,94,.10)",
          color: "rgba(210, 255, 226, .95)",
        }
      : {
          border: "1px solid rgba(255,255,255,.10)",
          background: "rgba(255,255,255,.05)",
          color: "rgba(255,255,255,.85)",
        };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        whiteSpace: "nowrap",
        ...toneStyle,
      }}
    >
      {children}
    </span>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,.55)" }}>
      {children}
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "rgba(255,255,255,.55)" }}>{children}</div>;
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <div className="mono" style={{ fontSize: 12, color: "rgba(255,255,255,.85)" }}>{children}</div>;
}
