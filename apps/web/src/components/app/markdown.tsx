import { Fragment, type ReactNode } from "react";

/*
 * A deliberately tiny Markdown subset for agent replies: paragraphs, bullet
 * and numbered lists, **bold**, `code` and fenced code blocks. Everything is
 * rendered as React text nodes — model output never reaches innerHTML.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(
        <strong key={`${key}-${i++}`} className="font-semibold text-fg">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <code key={`${key}-${i++}`} className="rounded-[4px] bg-white/[0.07] px-1 py-px font-mono text-[0.85em] text-fg">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre
          key={k++}
          className="overflow-x-auto rounded-lg bg-canvas/80 px-3 py-2.5 font-mono text-xs leading-relaxed text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)]"
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? numbered : bullet).test(lines[i])) {
        items.push(lines[i].replace(ordered ? numbered : bullet, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List
          key={k++}
          className={
            ordered
              ? "list-decimal space-y-1 pl-5 marker:text-fg-faint"
              : "space-y-1 pl-4 [&>li]:relative [&>li]:before:absolute [&>li]:before:top-[0.6em] [&>li]:before:-left-3 [&>li]:before:size-1 [&>li]:before:rounded-full [&>li]:before:bg-fg-faint"
          }
        >
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={k++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="space-y-3">{blocks}</div>;
}
