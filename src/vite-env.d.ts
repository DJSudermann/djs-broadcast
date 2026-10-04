/// <reference types="vite/client" />

interface Window {
  settings?: {
    base_url?: string;
    chatServer?: string;
    user?: {
      id?: number;
      hasPassword?: boolean;
    };
  };
}
