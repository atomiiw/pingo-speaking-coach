/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Mulish",
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        display: [
          "Mulish",
          "ui-sans-serif",
          "-apple-system",
          "sans-serif",
        ],
      },
      colors: {
        cream: {
          50:  "#ffffff",
          100: "#fafafa",
          150: "#f5f5f7",
          200: "#ebebed",
          300: "#d8d8dc",
          400: "#a8a8ad",
          500: "#86868b",
          600: "#6e6e73",
          700: "#48484a",
          800: "#1d1d1f",
          900: "#0b0b0c",
          950: "#000000",
        },
        grass: {
          50:  "#e9f8ea",
          100: "#c4ecc6",
          200: "#91db93",
          400: "#4cc259",
          500: "#34c759",
          600: "#2ca84a",
          700: "#248a3d",
        },
        coral: {
          100: "#ffe4e5",
          300: "#ffb6b7",
          400: "#ff9395",
          500: "#fe6e71",
          600: "#e54f52",
          700: "#b0383a",
        },
        sun: {
          100: "#fff8cc",
          200: "#fff099",
          300: "#ffe666",
          400: "#ffdd33",
          500: "#ffd302",
          600: "#ccaa00",
          700: "#886f00",
        },
        pingo: {
          50:  "#eef1ff",
          100: "#d0d9ff",
          200: "#a8b8ff",
          300: "#8097ff",
          400: "#5471ff",
          500: "#284dff",
          600: "#1f3edd",
          700: "#162fa8",
          800: "#0e207a",
          900: "#081659",
        },
      },
      letterSpacing: {
        widest: "0.22em",
      },
      boxShadow: {
        "press":       "0 5px 0 0 #0b0b0c",
        "press-sm":    "0 2px 0 0 #0b0b0c",
        "press-coral": "0 5px 0 0 #b0383a",
        "press-coral-sm": "0 2px 0 0 #b0383a",
        "press-sun":   "0 5px 0 0 #8c6d00",
        "card":        "0 1px 0 0 #ebebed",
      },
      transitionTimingFunction: {
        "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
        "out-expo":  "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        "fade-up": {
          "0%":   { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "highlight-sweep": {
          "0%":   { backgroundSize: "0% 100%" },
          "100%": { backgroundSize: "100% 100%" },
        },
        "wave": {
          "0%, 100%": { transform: "scaleY(0.35)" },
          "50%":      { transform: "scaleY(1)" },
        },
      },
      animation: {
        "fade-up": "fade-up 380ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 240ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "highlight-sweep":
          "highlight-sweep 520ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "wave": "wave 900ms cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
