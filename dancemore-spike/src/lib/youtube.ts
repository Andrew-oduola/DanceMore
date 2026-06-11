// Loads the official YouTube IFrame Player API once (guarded) so we can read
// the demo video's playback TIME (getCurrentTime) and control play/pause. We
// never read the video's pixels — only its timeline.

export type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
};

type PlayerCtorOptions = {
  host?: string;
  videoId: string;
  playerVars?: Record<string, number | string>;
  events?: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number; target: YTPlayer }) => void;
  };
};

export type YTApi = {
  Player: new (el: HTMLElement | string, opts: PlayerCtorOptions) => YTPlayer;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
};

declare global {
  interface Window {
    YT?: YTApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTApi> | null = null;

export function loadYouTubeApi(): Promise<YTApi> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("no window"));
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YTApi>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT as YTApi);
    };
    // Already injected by something else? Wait for the callback above.
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });
  return apiPromise;
}
