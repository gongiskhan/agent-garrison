import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17211d",
        field: "#f7f4ee",
        line: "#d8d1c4",
        brass: "#b08d4a",
        moss: "#536b4d",
        signal: "#256f86",
        danger: "#a64242"
      },
      boxShadow: {
        panel: "0 1px 2px rgba(23, 33, 29, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
