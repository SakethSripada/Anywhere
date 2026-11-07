"use client";

import { Check, Copy } from "lucide-react";
import { memo, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border bg-muted/40">
      <div className="flex h-9 items-center justify-between border-b px-3 text-xs text-muted-foreground">
        <span className="font-mono">{lang || "text"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto py-3 font-mono text-[12.5px] leading-6">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-10 shrink-0 pr-3 text-right text-muted-foreground/50 select-none">{i + 1}</span>
            <span className="pr-4 whitespace-pre">{line || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground">
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-2 font-semibold">{children}</h4>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b bg-muted/40 px-3 py-2 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-3 py-2 last:border-0">{children}</td>,
  hr: () => <hr className="my-5" />,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if (lang || text.includes("\n")) return <CodeBlock code={text} lang={lang} />;
    return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
  },
  pre: ({ children }) => <>{children}</>,
};

/** Agent replies. Model output is rendered as React nodes; raw HTML is never enabled. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-[15px] leading-7 text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
