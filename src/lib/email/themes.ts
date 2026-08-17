/**
 * Corporate email template themes.
 *
 * Each theme is a complete visual style (colors, fonts, layout) that can be
 * applied to any of the 5 email templates (welcome, kyc, offer, invoice, reminder).
 *
 * Tenant admins pick a theme in Settings → Email Templates → Theme, and that
 * theme is applied to all emails sent from their tenant. They can also
 * customize the theme colors + fonts without touching HTML.
 */

export interface EmailTheme {
  id: string;
  name: string;
  description: string;
  // Color palette
  primaryColor: string;
  primaryDark: string;
  accentColor: string;
  backgroundColor: string;
  cardColor: string;
  textColor: string;
  mutedTextColor: string;
  borderColor: string;
  // Typography
  fontFamily: string;
  headingFontFamily: string;
  // Layout
  borderRadius: string;
  headerStyle: "gradient" | "solid" | "minimal" | "bordered";
  buttonStyle: "rounded" | "pill" | "square";
  // Preview swatch for the UI
  swatch: string[];
}

export const EMAIL_THEMES: EmailTheme[] = [
  {
    id: "emerald-corporate",
    name: "Emerald Corporate",
    description: "Professional emerald gradient header. Clean, modern, trustworthy. Default theme.",
    primaryColor: "#0f766e",
    primaryDark: "#115e59",
    accentColor: "#14b8a6",
    backgroundColor: "#f8fafc",
    cardColor: "#ffffff",
    textColor: "#1e293b",
    mutedTextColor: "#64748b",
    borderColor: "#e2e8f0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    headingFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    borderRadius: "12px",
    headerStyle: "gradient",
    buttonStyle: "rounded",
    swatch: ["#0f766e", "#115e59", "#14b8a6", "#f8fafc"],
  },
  {
    id: "midnight-luxury",
    name: "Midnight Luxury",
    description: "Dark navy header with gold accents. Premium, sophisticated, executive feel.",
    primaryColor: "#1e293b",
    primaryDark: "#0f172a",
    accentColor: "#d4af37",
    backgroundColor: "#f1f5f9",
    cardColor: "#ffffff",
    textColor: "#0f172a",
    mutedTextColor: "#475569",
    borderColor: "#cbd5e1",
    fontFamily: "'Georgia', 'Times New Roman', serif",
    headingFontFamily: "'Georgia', 'Times New Roman', serif",
    borderRadius: "8px",
    headerStyle: "solid",
    buttonStyle: "square",
    swatch: ["#1e293b", "#0f172a", "#d4af37", "#f1f5f9"],
  },
  {
    id: "ocean-breeze",
    name: "Ocean Breeze",
    description: "Light blue gradient with white cards. Fresh, approachable, modern SaaS feel.",
    primaryColor: "#0284c7",
    primaryDark: "#0369a1",
    accentColor: "#38bdf8",
    backgroundColor: "#f0f9ff",
    cardColor: "#ffffff",
    textColor: "#0c4a6e",
    mutedTextColor: "#0369a1",
    borderColor: "#bae6fd",
    fontFamily: "'Inter', -apple-system, sans-serif",
    headingFontFamily: "'Inter', -apple-system, sans-serif",
    borderRadius: "16px",
    headerStyle: "gradient",
    buttonStyle: "pill",
    swatch: ["#0284c7", "#0369a1", "#38bdf8", "#f0f9ff"],
  },
  {
    id: "royal-purple",
    name: "Royal Purple",
    description: "Purple gradient with violet accents. Creative, premium, distinctive.",
    primaryColor: "#7c3aed",
    primaryDark: "#6d28d9",
    accentColor: "#a78bfa",
    backgroundColor: "#faf5ff",
    cardColor: "#ffffff",
    textColor: "#2e1065",
    mutedTextColor: "#6b21a8",
    borderColor: "#e9d5ff",
    fontFamily: "'Inter', -apple-system, sans-serif",
    headingFontFamily: "'Poppins', 'Inter', sans-serif",
    borderRadius: "12px",
    headerStyle: "gradient",
    buttonStyle: "rounded",
    swatch: ["#7c3aed", "#6d28d9", "#a78bfa", "#faf5ff"],
  },
  {
    id: "minimal-mono",
    name: "Minimal Mono",
    description: "Black & white with subtle gray. Ultra-clean, editorial, no distractions.",
    primaryColor: "#18181b",
    primaryDark: "#09090b",
    accentColor: "#52525b",
    backgroundColor: "#fafafa",
    cardColor: "#ffffff",
    textColor: "#18181b",
    mutedTextColor: "#71717a",
    borderColor: "#e4e4e7",
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    headingFontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    borderRadius: "4px",
    headerStyle: "bordered",
    buttonStyle: "square",
    swatch: ["#18181b", "#09090b", "#52525b", "#fafafa"],
  },
];

export const DEFAULT_THEME_ID = "emerald-corporate";

export function getTheme(id: string): EmailTheme {
  return EMAIL_THEMES.find((t) => t.id === id) || EMAIL_THEMES[0];
}

/**
 * Build the CSS for a theme — injected into the email HTML as inline styles.
 * Returns a string of CSS custom properties that the template HTML references.
 */
export function themeToCssVars(theme: EmailTheme): string {
  return `
    --color-primary: ${theme.primaryColor};
    --color-primary-dark: ${theme.primaryDark};
    --color-accent: ${theme.accentColor};
    --color-bg: ${theme.backgroundColor};
    --color-card: ${theme.cardColor};
    --color-text: ${theme.textColor};
    --color-muted: ${theme.mutedTextColor};
    --color-border: ${theme.borderColor};
    --font-body: ${theme.fontFamily};
    --font-heading: ${theme.headingFontFamily};
    --radius: ${theme.borderRadius};
  `;
}

/**
 * Build the header HTML for a theme.
 * headerStyle determines the visual treatment.
 */
export function buildHeader(theme: EmailTheme, title: string, subtitle?: string): string {
  const radius = theme.borderRadius;
  const radiusTop = `${radius} ${radius} 0 0`;

  if (theme.headerStyle === "gradient") {
    return `
      <div style="background: linear-gradient(135deg, ${theme.primaryColor}, ${theme.primaryDark}); color: white; padding: 30px; border-radius: ${radiusTop}; font-family: ${theme.headingFontFamily};">
        <h1 style="margin: 0; font-size: 24px; font-weight: 600;">${title}</h1>
        ${subtitle ? `<p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">${subtitle}</p>` : ""}
      </div>
    `;
  }

  if (theme.headerStyle === "solid") {
    return `
      <div style="background: ${theme.primaryColor}; color: white; padding: 30px; border-radius: ${radiusTop}; font-family: ${theme.headingFontFamily};">
        <h1 style="margin: 0; font-size: 24px; font-weight: 600;">${title}</h1>
        ${subtitle ? `<p style="margin: 8px 0 0; opacity: 0.9; font-size: 14px;">${subtitle}</p>` : ""}
      </div>
    `;
  }

  if (theme.headerStyle === "bordered") {
    return `
      <div style="background: ${theme.cardColor}; color: ${theme.textColor}; padding: 30px; border-radius: ${radiusTop}; border-bottom: 3px solid ${theme.primaryColor}; font-family: ${theme.headingFontFamily};">
        <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">${title}</h1>
        ${subtitle ? `<p style="margin: 8px 0 0; color: ${theme.mutedTextColor}; font-size: 14px;">${subtitle}</p>` : ""}
      </div>
    `;
  }

  // minimal
  return `
    <div style="background: ${theme.cardColor}; color: ${theme.textColor}; padding: 30px; border-radius: ${radiusTop}; font-family: ${theme.headingFontFamily};">
      <h1 style="margin: 0; font-size: 22px; font-weight: 500;">${title}</h1>
      ${subtitle ? `<p style="margin: 8px 0 0; color: ${theme.mutedTextColor}; font-size: 14px;">${subtitle}</p>` : ""}
    </div>
  `;
}

/**
 * Build a styled button link using the theme.
 */
export function buildButton(theme: EmailTheme, text: string, url: string): string {
  const radius =
    theme.buttonStyle === "pill" ? "999px" :
    theme.buttonStyle === "square" ? "0px" :
    `${theme.borderRadius}`;

  return `
    <a href="${url}" style="background: ${theme.primaryColor}; color: white; padding: 14px 36px; border-radius: ${radius}; text-decoration: none; font-weight: 600; display: inline-block; font-family: ${theme.fontFamily}; font-size: 15px;">
      ${text}
    </a>
  `;
}

/**
 * Wrap content in a themed email shell.
 */
export function buildEmailShell(theme: EmailTheme, headerHtml: string, bodyHtml: string, footerText?: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { margin: 0; padding: 0; background: ${theme.backgroundColor}; font-family: ${theme.fontFamily}; color: ${theme.textColor}; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .card { background: ${theme.cardColor}; border: 1px solid ${theme.borderColor}; border-top: none; border-radius: 0 0 ${theme.borderRadius} ${theme.borderRadius}; padding: 30px; }
        .footer { text-align: center; padding: 20px; color: ${theme.mutedTextColor}; font-size: 11px; }
        a { color: ${theme.primaryColor}; }
      </style>
    </head>
    <body>
      <div class="container">
        ${headerHtml}
        <div class="card">
          ${bodyHtml}
        </div>
        <div class="footer">
          ${footerText || `© ${new Date().getFullYear()} VELOS. All rights reserved.`}
        </div>
      </div>
    </body>
    </html>
  `;
}
