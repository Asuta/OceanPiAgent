"use client";

import { useEffect, useId, useState } from "react";

type MermaidDiagramProps = {
  chart: string;
};

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const id = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
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
  }, [chart, id]);

  if (error) {
    return (
      <div className="mermaid-block" data-mermaid-error="true">
        <div className="mermaid-error">Mermaid render failed: {error}</div>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-block" data-mermaid-pending="true">
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return <div className="mermaid-block" data-mermaid-rendered="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
