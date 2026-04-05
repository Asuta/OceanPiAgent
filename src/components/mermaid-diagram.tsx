"use client";

import { useEffect, useId, useState } from "react";

type MermaidDiagramProps = {
  chart: string;
};

type MermaidTheme = "default" | "dark";

function readMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") {
    return "default";
  }

  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const id = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<MermaidTheme>("default");

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    const syncTheme = () => {
      setTheme(readMermaidTheme());
    };
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === "attributes" && mutation.attributeName === "data-theme")) {
        syncTheme();
      }
    });

    syncTheme();
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
        });
        const { svg: renderedSvg } = await mermaid.render(`mermaid-${id.replace(/:/g, "-")}`, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (renderError) {
        if (!cancelled) {
          setSvg(null);
          setError(renderError instanceof Error ? renderError.message : "Unable to render Mermaid diagram.");
        }
      }
    }

    setSvg(null);
    setError(null);
    void renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, id, theme]);

  if (error) {
    return (
      <div className="mermaid-block" data-mermaid-error="true" data-mermaid-theme={theme}>
        <div className="mermaid-error">Mermaid render failed: {error}</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-block" data-mermaid-pending="true" data-mermaid-theme={theme}>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return <div className="mermaid-block" data-mermaid-rendered="true" data-mermaid-theme={theme} dangerouslySetInnerHTML={{ __html: svg }} />;
}
