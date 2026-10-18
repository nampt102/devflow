import type { ReactNode } from "react";

// Stroke icons (Lucide shapes, ISC licence), one visual language: 24px grid, 2px stroke, round caps.
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const SunIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Svg>
);
export const MoonIcon = () => (
  <Svg>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg>
    <path d="M5 12h14M12 5v14" />
  </Svg>
);
export const ArrowLeftIcon = () => (
  <Svg>
    <path d="m12 19-7-7 7-7M19 12H5" />
  </Svg>
);
export const EyeIcon = () => (
  <Svg>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const EyeOffIcon = () => (
  <Svg>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" />
  </Svg>
);
export const FileIcon = () => (
  <Svg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
  </Svg>
);
export const UploadIcon = () => (
  <Svg>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Svg>
);
export const XIcon = () => (
  <Svg size={16}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
export const CheckIcon = () => (
  <Svg>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const AlertIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </Svg>
);
export const InboxIcon = () => (
  <Svg size={28}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Svg>
);
export const DownloadIcon = () => (
  <Svg size={16}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </Svg>
);

/** The DevFlow mark: two linked steps in a rounded square. Uses currentColor so it follows the theme. */
export const LogoMark = () => (
  <svg className="logo-mark" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="26" height="26" rx="7" fill="currentColor" />
    <path d="M9 10h6a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3h0" style={{ stroke: "var(--background)" }} strokeWidth="2.2" strokeLinecap="round" />
    <circle cx="9" cy="10" r="1.9" style={{ fill: "var(--background)" }} />
    <circle cx="19" cy="18" r="1.9" style={{ fill: "var(--background)" }} />
  </svg>
);
