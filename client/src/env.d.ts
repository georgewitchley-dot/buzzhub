import 'react';
declare module 'react' {
  interface CSSProperties { [key: `--${string}`]: string | number | undefined }
}
declare global {
  interface Window { webkitAudioContext?: typeof AudioContext; BarcodeDetector?: any }
  interface Navigator { userAgentData?: { platform?: string } }
}
export {};
