"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import { Printer, ArrowLeft } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { LEGAL_OPERATOR } from "@/components/legal/legal-meta";

/* ═══════════════════════════════════════════════════════════════════════════
   VELOS legal document shell

   Renders a full legal document page in the trading-house design language:
   paper canvas, ink text, hairline rules, Fraunces display headings — the
   same surface the login/register screens use, so a prospective customer
   clicks a link during sign-up and lands on a page that looks like the
   platform's own hand, not a bolted-on template.

   The DOCUMENT BODY is English (the authoritative contract language). The
   CHROME around it (labels, buttons) is localized through the standard i18n
   system, like every other surface in the app.

   Structure per page:
   <LegalShell meta={TERMS_OF_SERVICE} toc={TOS_SECTIONS}>
     <TermsOfService />
   </LegalShell>

   Print: all interactive chrome is print:hidden; the document prints as a
   clean typeset sheet (numbered sections, no navigation).
   ═══════════════════════════════════════════════════════════════════════════ */

export interface LegalDocMeta {
  title: string;
  ref: string;
  version: string;
  effectiveDate: string;
  effectiveDateLabel: string;
}

export interface LegalTocEntry {
  n: number;
  id: string;
  title: string;
}

export function LegalShell({
  meta,
  toc,
  children,
}: {
  meta: LegalDocMeta;
  toc: LegalTocEntry[];
  children: ReactNode;
}) {
  const t = useT();

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground paper-grain">
      {/* Masthead — brand row + back link */}
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-[860px] items-center gap-3 px-5 py-5 sm:px-8">
          <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-border">
            <Image
              src="/logo.svg"
              alt="VELOS"
              width={36}
              height={36}
              priority
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <p className="font-display text-base leading-none font-medium">VELOS</p>
            <p className="label-caps mt-1 text-muted-foreground">{t("login-brand-tagline")}</p>
          </div>
          <a
            href="/register"
            className="ml-auto hidden items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline sm:flex print:hidden"
          >
            <ArrowLeft className="size-3.5" />
            {t("legal-back")}
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[860px] flex-1 px-5 py-10 sm:px-8 sm:py-14">
        {/* Document header — kicker, title, identity row */}
        <div>
          <div className="rule-double w-12" aria-hidden />
          <p className="label-caps mt-6 text-primary">{LEGAL_OPERATOR.legalEntity}</p>
          <h1 className="font-display mt-3 text-[2.2rem] leading-[1.1] font-medium tracking-[-0.01em] sm:text-[2.6rem]">
            {meta.title}
          </h1>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-[11px] text-muted-foreground">
            <span>
              {t("legal-effective")}:{" "}
              <span className="text-foreground">{meta.effectiveDateLabel}</span>
            </span>
            <span>
              {t("legal-version")}: <span className="text-foreground">{meta.version}</span>
            </span>
            <span className="hidden sm:inline">{meta.ref}</span>
          </div>
        </div>

        {/* Authoritative-language notice */}
        <p className="mt-6 border-l-2 border-primary/60 bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {t("legal-english-note")}
        </p>

        {/* Contents — numbered ledger */}
        <nav aria-label={t("legal-contents")} className="mt-10 print:hidden">
          <p className="label-caps text-foreground/60">{t("legal-contents")}</p>
          <ol className="mt-3 border-t border-border">
            {toc.map((entry) => (
              <li key={entry.id} className="border-b border-border">
                <a
                  href={`#${entry.id}`}
                  className="group flex items-baseline gap-4 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <span className="w-7 shrink-0 font-mono text-[11px] tabular text-primary">
                    {String(entry.n).padStart(2, "0")}
                  </span>
                  <span className="text-sm text-foreground/80 group-hover:text-foreground">
                    {entry.title}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* Document body */}
        <div className="legal-body mt-12 border-t border-border pt-2">{children}</div>

        {/* Operator signature block */}
        <div className="mt-14 border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
          <p>
            {meta.title} · {meta.ref} v{meta.version} · {t("legal-effective")}{" "}
            {meta.effectiveDateLabel}
          </p>
          <p className="mt-1">
            {LEGAL_OPERATOR.legalEntity} · {LEGAL_OPERATOR.registeredOffice}
          </p>
        </div>
      </main>

      {/* Footer — back + print + colophon */}
      <footer className="border-t border-border print:hidden">
        <div className="mx-auto flex w-full max-w-[860px] flex-wrap items-center gap-4 px-5 py-5 sm:px-8">
          <a
            href="/register"
            className="flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            {t("legal-back")}
          </a>
          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            <Printer className="size-3.5" />
            {t("legal-print")}
          </button>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
            © {new Date().getFullYear()} {LEGAL_OPERATOR.legalEntity} · {t("login-rights")}
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ── Body markup helpers (shared by both documents) ─────────────────────── */

/** Numbered top-level section with an anchor the TOC links to. */
export function LegalSection({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={`sec-${n}`} className="scroll-mt-8 pt-10 first:pt-8">
      <h2 className="flex items-baseline gap-3 font-display text-xl leading-snug font-medium tracking-[-0.01em]">
        <span className="font-mono text-[12px] tabular text-primary">
          {String(n).padStart(2, "0")}
        </span>
        <span>{title}</span>
      </h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

/** Numbered subsection, e.g. 5.2 — pass the exact number as a string. */
export function LegalSub({
  n,
  title,
  children,
}: {
  n: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="ml-1 space-y-3 sm:ml-4">
      {title ? (
        <h3 className="flex items-baseline gap-2.5 text-[15px] font-medium">
          <span className="font-mono text-[11px] tabular text-muted-foreground">{n}</span>
          <span>{title}</span>
        </h3>
      ) : null}
      {children}
    </div>
  );
}

/** Single clause without a number — flows inside a section. */
export function LegalP({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-[1.75] text-foreground/80">{children}</p>;
}

/** Compact clause list — ordered (1, 2, 3) or unordered (bullets). */
export function LegalList({
  ordered = false,
  children,
}: {
  ordered?: boolean;
  children: ReactNode;
}) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={
        (ordered ? "list-decimal" : "list-disc") +
        " space-y-2 pl-5 text-sm leading-[1.7] text-foreground/80 marker:text-primary/70"
      }
    >
      {children}
    </Tag>
  );
}

/** One clause in a LegalList. With `term`, renders as a definition row. */
export function LegalLi({ term, children }: { term?: string; children: ReactNode }) {
  return (
    <li className="leading-[1.7] text-foreground/80">
      {term ? (
        <>
          <strong className="font-medium text-foreground">{term}</strong>
          {" — "}
        </>
      ) : null}
      {children}
    </li>
  );
}

/** Hairline-ruled table (legal bases, retention periods, processors). */
export function LegalTable({
  head,
  rows,
}: {
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {head.map((h, i) => (
              <th
                key={i}
                className="px-3 py-2.5 text-left font-display text-[13px] font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/60 last:border-b-0">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2.5 align-top text-[13px] leading-relaxed text-foreground/80">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
