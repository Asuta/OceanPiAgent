import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";

const defaultAttributes = defaultSchema.attributes ?? {};

const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultAttributes,
    code: [...(("code" in defaultAttributes && defaultAttributes.code) || []), ["className", /^language-[\w-]+$/]],
  },
};

type MarkdownMessageProps = {
  content: string;
  className?: string;
};

function isExternalLink(href: string | undefined) {
  return typeof href === "string" && /^(?:[a-z]+:)?\/\//i.test(href);
}

function getCodeLanguage(className: string | undefined) {
  const match = className?.match(/(?:^|\s)language-([\w-]+)(?:\s|$)/);
  return match?.[1]?.toLowerCase() ?? null;
}

type MarkdownCodeProps = ComponentProps<"code"> & {
  node?: unknown;
};

function CodeBlock({ className, children, node, ...props }: MarkdownCodeProps) {
  void node;
  const language = getCodeLanguage(className);
  const textContent = Array.isArray(children) ? children.join("") : String(children ?? "");

  if (language === "mermaid") {
    return <MermaidDiagram chart={textContent.replace(/\n$/, "")} />;
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

export function MarkdownMessage({ content, className }: MarkdownMessageProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, markdownSchema]]}
        components={{
          a({ href, children, node, ...props }) {
            void node;
            const external = isExternalLink(href);
            return (
              <a
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {children}
              </a>
            );
          },
          code: CodeBlock,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
