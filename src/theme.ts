export type BroadcastTheme = 'light' | 'dark';

export function resolveChurchToolsTheme(
  classNames: string[],
  storedTheme: string | null,
  systemDark: boolean,
  darkModeQuery = false
): BroadcastTheme {
  const classes = new Set(classNames.flatMap(value => value.toLocaleLowerCase().split(/\s+/)).filter(Boolean));
  if (classes.has('dark')) return 'dark';
  if (classes.has('light')) return 'light';
  if (darkModeQuery || storedTheme === 'dark' || (storedTheme === 'system' && systemDark)) return 'dark';
  return 'light';
}

function hostWindow(): Window {
  try {
    if (window.parent && window.parent !== window && window.parent.document) return window.parent;
  } catch {
    // Bei einer fremden Origin ist nur das eigene Dokument zugänglich.
  }
  return window;
}

export function installChurchToolsThemeSync(): () => void {
  const host = hostWindow();
  const media = host.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const classNames = [host.document.documentElement.className, host.document.body?.className || ''];
    let storedTheme: string | null = null;
    try { storedTheme = host.localStorage.getItem('theme'); } catch { /* Storage may be unavailable. */ }
    const darkModeQuery = new URL(host.location.href).searchParams.get('darkmode') === 'true';
    const theme = resolveChurchToolsTheme(classNames, storedTheme, media.matches, darkModeQuery);
    document.documentElement.dataset.broadcastTheme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  const observer = new MutationObserver(apply);
  observer.observe(host.document.documentElement, { attributes: true, attributeFilter: ['class'] });
  if (host.document.body) observer.observe(host.document.body, { attributes: true, attributeFilter: ['class'] });
  const onStorage = (event: StorageEvent) => { if (event.key === 'theme') apply(); };
  host.addEventListener('storage', onStorage);
  media.addEventListener('change', apply);
  apply();
  return () => {
    observer.disconnect();
    host.removeEventListener('storage', onStorage);
    media.removeEventListener('change', apply);
  };
}
