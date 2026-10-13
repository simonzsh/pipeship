import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";

type Theme = "light" | "dark" | "system";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const ICON = { light: Sun, dark: Moon, system: Monitor };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) ?? "system");

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    apply();
    localStorage.setItem("theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const Icon = ICON[theme];
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(NEXT[theme])} title={`Theme: ${theme}`}>
      <Icon />
    </Button>
  );
}
