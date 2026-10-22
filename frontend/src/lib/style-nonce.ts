export function getStyleNonce(): string | undefined {
  const value =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLMetaElement>('meta[name="apix-style-nonce"]')?.content
      : undefined;
  return value && !value.startsWith('__') ? value : undefined;
}
