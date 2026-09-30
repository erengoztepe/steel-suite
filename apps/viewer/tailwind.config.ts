import plugin from "tailwindcss/plugin";
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./*.{ts,tsx}", "./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      animation: {
        "progress-fill": "progress-fill 5s linear forwards",
        "fade-in": "fade-in 0.3s ease-out",
        "slide-in-right": "slide-in-right 0.22s cubic-bezier(0.16,1,0.3,1)",
        "slide-in-left": "slide-in-left 0.22s cubic-bezier(0.16,1,0.3,1)",
      },

      colors: {
        bg: {
          overlay: "rgb(var(--background-secondary) / 0.5)",

          primary: {
            DEFAULT: "rgb(var(--background-primary) / <alpha-value>)",
            transparent: "rgb(var(--background-primary) / 0.9)",
          },

          quaternary: {
            DEFAULT: "rgb(var(--background-quaternary) / <alpha-value>)",
          },

          secondary: {
            DEFAULT: "rgb(var(--background-secondary) / <alpha-value>)",
            transparent: "rgb(var(--background-secondary) / 0.8)",
          },

          tertiary: "rgb(var(--background-tertiary) / 0.05)",
        },

        border: {
          disabled: "rgb(var(--border-disabled) / <alpha-value>)",
          input: "rgb(var(--border-input) / <alpha-value>)",
          primary: "rgb(var(--border-primary) / 0.2)",
          secondary: "rgb(var(--border-secondary) / 0.3)",
          tertiary: "rgb(var(--border-primary) / 0.1)",
        },

        brand: {
          primary: {
            DEFAULT: "rgb(var(--brand-primary) / <alpha-value>)",
            disabled: "rgb(var(--brand-primary) / 0.4)",
            hover: "rgb(var(--brand-primary) / 0.2)",
          },

          secondary: {
            DEFAULT: "rgb(var(--brand-secondary) / <alpha-value>)",
            disabled: "rgb(var(--brand-secondary) / 0.4)",
            hover: "rgb(var(--brand-secondary-hover) / <alpha-value>)",
          },
        },

        chart: {
          "1": "rgb(var(--chart-1) / <alpha-value>)",
          "2": "rgb(var(--chart-2) / <alpha-value>)",
          "3": "rgb(var(--chart-3) / <alpha-value>)",
          "4": "rgb(var(--chart-4) / <alpha-value>)",
          "5": "rgb(var(--chart-5) / <alpha-value>)",
        },

        status: {
          success: {
            DEFAULT: "rgb(var(--status-success) / <alpha-value>)",
            light: "rgb(var(--status-success-light) / <alpha-value>)",
            transparent: "rgb(var(--status-success) / 0.2)",
          },

          warning: {
            DEFAULT: "rgb(var(--status-warning) / <alpha-value>)",
            light: "rgb(var(--status-warning-light) / <alpha-value>)",
            transparent: "rgb(var(--status-warning) / 0.2)",
          },

          error: {
            DEFAULT: "rgb(var(--status-error) / <alpha-value>)",
            light: "rgb(var(--status-error-light) / <alpha-value>)",
            transparent: "rgb(var(--status-error) / 0.2)",
          },

          info: {
            DEFAULT: "rgb(var(--status-info) / <alpha-value>)",
            light: {
              DEFAULT: "rgb(var(--status-info-light) / <alpha-value>)",
              transparent: {
                DEFAULT: "rgb(var(--status-info-light) / 0.4)",
                v2: "rgb(var(--status-info-light) / 0.2)",
              },
            },
            transparent: "rgb(var(--status-info) / 0.1)",
          },
        },

        text: {
          accent: "rgb(var(--text-accent) / <alpha-value>)",
          disabled: "rgb(var(--text-primary) / 0.4)",
          link: "rgb(var(--text-link) / <alpha-value>)",
          primary: "rgb(var(--text-primary) / <alpha-value>)",
          secondary: "rgb(var(--text-secondary) / <alpha-value>)",
          tertiary: "rgb(var(--text-primary) / 0.6)",
        },

        // BIM compliance / viewer panel palette (same as main theme, for consistent panel UI)
        "bim-compliance": {
          background: "rgb(var(--background-primary) / 0.95)",
          "background-secondary": "rgb(var(--background-secondary) / <alpha-value>)",
          "background-secondary-alt": "rgb(var(--background-secondary) / 0.6)",
          "background-input": "rgb(var(--background-quaternary) / <alpha-value>)",
          "background-table": "rgb(var(--background-quaternary) / 0.4)",
          "primary-border": "rgb(var(--border-primary) / 0.3)",
          "primary-border-alt": "rgb(var(--border-primary) / 0.15)",
          "secondary-border": "rgb(var(--border-secondary) / 0.25)",
          "secondary-border-alt": "rgb(var(--border-secondary) / 0.15)",
          "active-border": "rgb(var(--brand-primary) / 0.5)",
          "active-border-secondary": "rgb(var(--brand-primary) / 0.25)",
          "table-border": "rgb(var(--border-primary) / 0.2)",
          "text-primary": "rgb(var(--text-primary) / <alpha-value>)",
          "text-secondary": "rgb(var(--text-secondary) / <alpha-value>)",
          "text-secondary-alt": "rgb(var(--text-primary) / 0.7)",
          "text-button": "rgb(var(--text-primary) / <alpha-value>)",
          "text-error": "rgb(var(--status-error) / <alpha-value>)",
        },
      },

      keyframes: {
        "progress-fill": {
          "0%": { width: "0%" },
          "100%": { width: "100%" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(16px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          "0%": { opacity: "0", transform: "translateX(-16px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [
    require("@headlessui/tailwindcss"),
    require("@tailwindcss/typography"),
    plugin(function ({ addVariant }) {
      addVariant("not-last", "&:not(:last-child)");
    }),
  ],
};
export default config;
