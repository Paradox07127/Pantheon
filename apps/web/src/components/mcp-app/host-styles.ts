/** Each standard MCP Apps style variable and the app token it takes its value from. */
const TOKENS: Record<string, string> = {
  '--color-background-primary': '--sf',
  '--color-background-secondary': '--sf2',
  '--color-background-tertiary': '--bg',
  '--color-background-inverse': '--ink',
  '--color-background-danger': '--bad-bg',
  '--color-background-success': '--ok-bg',
  '--color-background-warning': '--wait-bg',
  '--color-background-info': '--unk-bg',
  '--color-text-primary': '--tx',
  '--color-text-secondary': '--tx2',
  '--color-text-tertiary': '--mu',
  '--color-text-inverse': '--on-ink',
  '--color-text-danger': '--bad',
  '--color-text-success': '--ok',
  '--color-text-warning': '--wait',
  '--color-text-info': '--run',
  '--color-text-disabled': '--faint',
  '--color-border-primary': '--bd',
  '--color-border-secondary': '--bd2',
  '--color-border-tertiary': '--bd3',
  '--color-ring-primary': '--focus-ring',
  '--font-sans': '--font-sans',
  '--font-mono': '--font-mono',
  '--font-text-xs-size': '--fs-xs',
  '--font-text-sm-size': '--fs-sm',
  '--font-text-md-size': '--fs-md',
  '--font-text-lg-size': '--fs-lg',
  '--font-text-xs-line-height': '--lh-xs',
  '--font-text-sm-line-height': '--lh-sm',
  '--font-text-md-line-height': '--lh-md',
  '--font-text-lg-line-height': '--lh-lg',
  '--border-radius-sm': '--r-sm',
  '--border-radius-md': '--r-md',
  '--border-radius-lg': '--r-lg',
  '--border-radius-xl': '--r-xl',
  '--border-width-regular': '--hair',
};

/** The standard style variables an MCP App receives, read from the app's current tokens; unset tokens are left out. */
export function hostStyles(read: (token: string) => string): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const [name, token] of Object.entries(TOKENS)) {
    const value = read(token).trim();
    if (value) styles[name] = value;
  }
  return styles;
}
