import type { SVGProps } from "react";

/**
 * Anywhere's icon set. Drawn by hand on a 20px grid with a 1.5px stroke,
 * round caps, and optical alignment to a 2px inner padding so every glyph
 * shares the same visual weight. Render at 16px (dense UI) or 20px.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

const make = (paths: React.ReactNode, displayName: string) => {
  const C = (p: IconProps) => <Icon {...p}>{paths}</Icon>;
  C.displayName = displayName;
  return C;
};

/* ── Brand ─────────────────────────────────────────────────────────────── */

/** The Anywhere mark: an open orbit with a node in transit. */
export function Mark({ size = 20, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M19.4 8.2A8 8 0 1 0 20 12"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
      />
      <path d="M12 8.5a3.5 3.5 0 1 0 3.5 3.5" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" opacity={0.45} />
      <circle cx="19.9" cy="4.6" r="2.1" fill="var(--color-accent, currentColor)" />
    </svg>
  );
}

/* ── Navigation ────────────────────────────────────────────────────────── */

export const IconWorkspace = make(
  <>
    <rect x="3" y="3" width="14" height="14" rx="3.5" />
    <path d="M3 8h14" />
    <path d="M8 8v9" />
  </>,
  "IconWorkspace",
);

export const IconDesktop = make(
  <>
    <rect x="2.75" y="3.5" width="14.5" height="10" rx="2" />
    <path d="M7.5 16.75h5" />
    <path d="M10 13.5v3.25" />
  </>,
  "IconDesktop",
);

export const IconWorkload = make(
  <>
    <path d="M10 2.75 17 6.5l-7 3.75L3 6.5l7-3.75Z" />
    <path d="m3 10 7 3.75L17 10" />
    <path d="m3 13.5 7 3.75 7-3.75" />
  </>,
  "IconWorkload",
);

export const IconFolder = make(
  <path d="M2.75 6.25a2 2 0 0 1 2-2h3.1c.5 0 .98.19 1.35.53l1.1 1.02c.37.34.85.53 1.35.53h3.6a2 2 0 0 1 2 2v6.42a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2V6.25Z" />,
  "IconFolder",
);

export const IconFile = make(
  <>
    <path d="M11.25 2.75H6a2 2 0 0 0-2 2v10.5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7.5l-4.75-4.75Z" />
    <path d="M11 3v4.5h4.75" />
  </>,
  "IconFile",
);

export const IconSettings = make(
  <>
    <path d="M3.5 6h6.75" />
    <path d="M14.25 6h2.25" />
    <circle cx="12.25" cy="6" r="2" />
    <path d="M3.5 14h2.25" />
    <path d="M9.75 14h6.75" />
    <circle cx="7.75" cy="14" r="2" />
  </>,
  "IconSettings",
);

export const IconMessage = make(
  <path d="M10 16.25c4.14 0 7.25-2.8 7.25-6.25S14.14 3.75 10 3.75 2.75 6.55 2.75 10c0 1.4.51 2.69 1.38 3.73L3.5 16.5l3.1-.97c1 .46 2.15.72 3.4.72Z" />,
  "IconMessage",
);

/* ── Compute ───────────────────────────────────────────────────────────── */

export const IconGpu = make(
  <>
    <rect x="2.75" y="5.25" width="14.5" height="9.5" rx="1.75" />
    <circle cx="12.75" cy="10" r="2.25" />
    <path d="M5.75 8.25h2.5M5.75 11.75h2.5" />
    <path d="M5 14.75v2M8 14.75v2" />
  </>,
  "IconGpu",
);

export const IconCpu = make(
  <>
    <rect x="5" y="5" width="10" height="10" rx="2" />
    <rect x="8" y="8" width="4" height="4" rx=".75" />
    <path d="M8 2.75V5M12 2.75V5M8 15v2.25M12 15v2.25M2.75 8H5M2.75 12H5M15 8h2.25M15 12h2.25" />
  </>,
  "IconCpu",
);

export const IconMemory = make(
  <>
    <rect x="2.75" y="6" width="14.5" height="7.5" rx="1.5" />
    <path d="M6 9v1.5M9 9v1.5M12 9v1.5M15 9v1.5" />
    <path d="M5 13.5V16M10 13.5V16M15 13.5V16" />
  </>,
  "IconMemory",
);

export const IconStorage = make(
  <>
    <ellipse cx="10" cy="5.25" rx="6.25" ry="2.25" />
    <path d="M3.75 5.25v9.5c0 1.24 2.8 2.25 6.25 2.25s6.25-1 6.25-2.25v-9.5" />
    <path d="M3.75 10c0 1.24 2.8 2.25 6.25 2.25s6.25-1 6.25-2.25" />
  </>,
  "IconStorage",
);

export const IconTerminal = make(
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.25" />
    <path d="m6.25 8 2.25 2-2.25 2" />
    <path d="M10.75 12.25h3" />
  </>,
  "IconTerminal",
);

export const IconCloud = make(
  <path d="M5.75 15.25a3.5 3.5 0 0 1-.6-6.95 5 5 0 0 1 9.6 1.2 2.9 2.9 0 0 1-.25 5.75H5.75Z" />,
  "IconCloud",
);

export const IconActivity = make(<path d="M2.75 10h3l2-5 4 10 2-5h3.5" />, "IconActivity");

export const IconLogs = make(
  <>
    <path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h6" />
    <path d="M3.5 5.5h.5M3.5 10h.5M3.5 14.5h.5" strokeWidth={2} />
  </>,
  "IconLogs",
);

export const IconMetrics = make(
  <>
    <path d="M3 3v12.25c0 .97.78 1.75 1.75 1.75H17" />
    <path d="m6.5 12.25 3-3.5 2.5 2 4-5" />
  </>,
  "IconMetrics",
);

export const IconWallet = make(
  <>
    <path d="M15.25 6.25V5a1.75 1.75 0 0 0-1.75-1.75h-8.5A2.25 2.25 0 0 0 2.75 5.5v9a2.25 2.25 0 0 0 2.25 2.25h10.25a2 2 0 0 0 2-2V8.25a2 2 0 0 0-2-2H5" />
    <circle cx="13.5" cy="11.5" r=".9" fill="currentColor" stroke="none" />
  </>,
  "IconWallet",
);

export const IconClock = make(
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 6v4l2.5 1.75" />
  </>,
  "IconClock",
);

/* ── Agent & control ───────────────────────────────────────────────────── */

/** A pointer with an orbit: the agent is driving. */
export const IconAgent = make(
  <>
    <path d="m4 3.5 9.5 4-4 1.5-1.5 4-4-9.5Z" />
    <path d="M12 12.25a4.25 4.25 0 0 0 4.6 3.4" />
    <circle cx="16" cy="11" r="1.1" fill="currentColor" stroke="none" />
  </>,
  "IconAgent",
);

export const IconCursor = make(<path d="m4.5 3.5 11 4.75-4.6 1.65L9.25 14.5 4.5 3.5Z" />, "IconCursor");

/** Manual takeover. */
export const IconHand = make(
  <path d="M7 10.25V4.5a1.25 1.25 0 0 1 2.5 0v4.75-6a1.25 1.25 0 0 1 2.5 0v6-4.25a1.25 1.25 0 0 1 2.5 0v6.75a5.5 5.5 0 0 1-5.5 5.5h-.36a5 5 0 0 1-3.86-1.82L2.9 12.6a1.3 1.3 0 0 1 1.94-1.72L7 12.75v-2.5Z" />,
  "IconHand",
);

export const IconKeyboard = make(
  <>
    <rect x="2.25" y="5" width="15.5" height="10" rx="2" />
    <path d="M5.5 8.25h.01M8.5 8.25h.01M11.5 8.25h.01M14.5 8.25h.01M7 12h6" strokeWidth={1.75} />
  </>,
  "IconKeyboard",
);

export const IconEye = make(
  <>
    <path d="M2.5 10s2.75-5.25 7.5-5.25S17.5 10 17.5 10s-2.75 5.25-7.5 5.25S2.5 10 2.5 10Z" />
    <circle cx="10" cy="10" r="2.25" />
  </>,
  "IconEye",
);

/* ── Actions ───────────────────────────────────────────────────────────── */

export const IconPlay = make(<path d="M6.5 4.6v10.8a.8.8 0 0 0 1.2.7l8.65-5.4a.8.8 0 0 0 0-1.36L7.7 3.9a.8.8 0 0 0-1.2.7Z" />, "IconPlay");
export const IconStop = make(<rect x="5" y="5" width="10" height="10" rx="2" />, "IconStop");
export const IconPause = make(<path d="M7 4.75v10.5M13 4.75v10.5" strokeWidth={2} />, "IconPause");
export const IconPower = make(
  <>
    <path d="M10 2.75V9" />
    <path d="M6 5.4a6.25 6.25 0 1 0 8 0" />
  </>,
  "IconPower",
);
export const IconPlus = make(<path d="M10 4.25v11.5M4.25 10h11.5" />, "IconPlus");
export const IconArrowUp = make(<path d="M10 15.75V4.25M5 9.25l5-5 5 5" />, "IconArrowUp");
export const IconArrowRight = make(<path d="M4.25 10h11.5M10.75 5l5 5-5 5" />, "IconArrowRight");
export const IconArrowUpRight = make(<path d="M6 14 14 6M7.25 6H14v6.75" />, "IconArrowUpRight");
export const IconChevronDown = make(<path d="m6 8 4 4 4-4" />, "IconChevronDown");
export const IconChevronRight = make(<path d="m8 6 4 4-4 4" />, "IconChevronRight");
export const IconChevronLeft = make(<path d="m12 6-4 4 4 4" />, "IconChevronLeft");
export const IconChevronUpDown = make(<path d="m7 7.5 3-3 3 3M7 12.5l3 3 3-3" />, "IconChevronUpDown");
export const IconCheck = make(<path d="m4.75 10.5 3.25 3.25 7.25-7.5" />, "IconCheck");
export const IconClose = make(<path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />, "IconClose");
export const IconMore = make(
  <path d="M5 10h.01M10 10h.01M15 10h.01" strokeWidth={2.25} />,
  "IconMore",
);
export const IconSearch = make(
  <>
    <circle cx="9" cy="9" r="5.75" />
    <path d="m13.25 13.25 3.5 3.5" />
  </>,
  "IconSearch",
);
export const IconCopy = make(
  <>
    <rect x="6.75" y="6.75" width="10" height="10" rx="2" />
    <path d="M13.25 6.75V5a1.75 1.75 0 0 0-1.75-1.75H5A1.75 1.75 0 0 0 3.25 5v6.5c0 .97.78 1.75 1.75 1.75h1.75" />
  </>,
  "IconCopy",
);
export const IconRefresh = make(
  <>
    <path d="M16.25 10a6.25 6.25 0 1 1-1.83-4.42" />
    <path d="M16.25 3.5v3.75H12.5" />
  </>,
  "IconRefresh",
);
export const IconDownload = make(<path d="M10 3.25v9.5M5.75 8.75 10 13l4.25-4.25M3.75 16.75h12.5" />, "IconDownload");
export const IconUpload = make(<path d="M10 13V3.5M5.75 7.75 10 3.5l4.25 4.25M3.75 16.75h12.5" />, "IconUpload");
export const IconExpand = make(<path d="M11.75 3.5h4.75v4.75M8.25 16.5H3.5v-4.75M16.5 3.5l-5 5M3.5 16.5l5-5" />, "IconExpand");
export const IconSidebar = make(
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.25" />
    <path d="M7.75 3.75v12.5" />
  </>,
  "IconSidebar",
);
export const IconPaperclip = make(
  <path d="m15.5 9.25-5.6 5.6a3.5 3.5 0 0 1-4.95-4.95l5.95-5.95a2.33 2.33 0 0 1 3.3 3.3l-5.97 5.97a1.17 1.17 0 0 1-1.65-1.65l5.6-5.6" />,
  "IconPaperclip",
);
export const IconSave = make(
  <>
    <path d="M3.25 5a1.75 1.75 0 0 1 1.75-1.75h7.88c.46 0 .9.18 1.23.51l2.13 2.13c.33.33.51.77.51 1.23V15a1.75 1.75 0 0 1-1.75 1.75H5A1.75 1.75 0 0 1 3.25 15V5Z" />
    <path d="M6.5 16.75v-4.5h7v4.5M6.75 3.25v3h5.5v-3" />
  </>,
  "IconSave",
);

/* ── Status ────────────────────────────────────────────────────────────── */

export const IconAlert = make(
  <>
    <path d="M8.48 3.6a1.75 1.75 0 0 1 3.04 0l5.8 10.12A1.75 1.75 0 0 1 15.8 16.4H4.2a1.75 1.75 0 0 1-1.52-2.62L8.48 3.6Z" />
    <path d="M10 8v3M10 13.6h.01" />
  </>,
  "IconAlert",
);
export const IconInfo = make(
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 9.25v4.5M10 6.5h.01" />
  </>,
  "IconInfo",
);
export const IconLock = make(
  <>
    <rect x="4" y="8.75" width="12" height="8.5" rx="2" />
    <path d="M6.75 8.75V6.5a3.25 3.25 0 0 1 6.5 0v2.25" />
  </>,
  "IconLock",
);
export const IconShield = make(
  <>
    <path d="M10 2.75 4 5v4.6c0 3.5 2.55 6.6 6 7.65 3.45-1.05 6-4.15 6-7.65V5l-6-2.25Z" />
    <path d="m7.5 10 1.75 1.75L12.75 8.5" />
  </>,
  "IconShield",
);
export const IconPhone = make(
  <>
    <rect x="5.5" y="2.75" width="9" height="14.5" rx="2.25" />
    <path d="M9 14.25h2" />
  </>,
  "IconPhone",
);
export const IconLink = make(
  <>
    <path d="M8.5 11.5a3.25 3.25 0 0 0 4.6 0l2.4-2.4a3.25 3.25 0 0 0-4.6-4.6l-.9.9" />
    <path d="M11.5 8.5a3.25 3.25 0 0 0-4.6 0l-2.4 2.4a3.25 3.25 0 0 0 4.6 4.6l.9-.9" />
  </>,
  "IconLink",
);
export const IconCommand = make(
  <path d="M7.5 7.5V5.25a2.25 2.25 0 1 0-2.25 2.25H14.75A2.25 2.25 0 1 0 12.5 5.25v9.5a2.25 2.25 0 1 0 2.25-2.25H5.25A2.25 2.25 0 1 0 7.5 14.75V7.5Z" />,
  "IconCommand",
);
export const IconCube = make(
  <>
    <path d="M10 2.75 16.5 6.4v7.2L10 17.25 3.5 13.6V6.4L10 2.75Z" />
    <path d="M3.75 6.5 10 10l6.25-3.5M10 10v7" />
  </>,
  "IconCube",
);
export const IconBrain = make(
  <>
    <path d="M10 4.75v10.5" />
    <path d="M10 4.75A2.5 2.5 0 0 0 5.6 3.9 2.6 2.6 0 0 0 3.9 8a2.8 2.8 0 0 0 .6 4.8A2.7 2.7 0 0 0 10 15.25" />
    <path d="M10 4.75a2.5 2.5 0 0 1 4.4-.85A2.6 2.6 0 0 1 16.1 8a2.8 2.8 0 0 1-.6 4.8 2.7 2.7 0 0 1-5.5 2.45" />
  </>,
  "IconBrain",
);
