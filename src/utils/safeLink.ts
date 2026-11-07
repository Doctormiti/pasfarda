/**
 * Safe Link Sanitizer and Validator for Top Banners and UI Links
 */

export interface SafeLinkResult {
  href: string;
  target?: '_blank' | '_self';
  rel?: string;
  isExternal: boolean;
  isAllowed: boolean;
}

const BLOCKED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'];

export function safeLink(url?: string, openInNewTab: boolean = false): SafeLinkResult {
  if (!url || typeof url !== 'string') {
    return {
      href: '#',
      isExternal: false,
      isAllowed: false,
    };
  }

  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();

  // Block dangerous schemes immediately
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return {
        href: '#',
        isExternal: false,
        isAllowed: false,
      };
    }
  }

  // Allowed external schemes
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return {
      href: trimmed,
      target: openInNewTab ? '_blank' : undefined,
      rel: openInNewTab ? 'noopener noreferrer' : undefined,
      isExternal: true,
      isAllowed: true,
    };
  }

  // Allowed internal paths and relative fragments/queries
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?') ||
    trimmed === ''
  ) {
    return {
      href: trimmed || '#',
      target: openInNewTab ? '_blank' : undefined,
      rel: openInNewTab ? 'noopener noreferrer' : undefined,
      isExternal: false,
      isAllowed: true,
    };
  }

  // Fallback for simple slug-like relative routes (e.g. "articles" -> "/articles")
  if (/^[a-zA-Z0-9_\-./?#]+$/.test(trimmed)) {
    const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return {
      href: prefixed,
      target: openInNewTab ? '_blank' : undefined,
      rel: openInNewTab ? 'noopener noreferrer' : undefined,
      isExternal: false,
      isAllowed: true,
    };
  }

  return {
    href: '#',
    isExternal: false,
    isAllowed: false,
  };
}
