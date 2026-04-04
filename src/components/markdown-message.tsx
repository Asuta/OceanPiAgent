import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const defaultAttributes = defaultSchema.attributes ?? {};

const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultAttributes,
    code: [
      ...(("code" in defaultAttributes && defaultAttributes.code) || []),
      ["className", /^language-[\w-]+$/],
    ],
  },
};

type MarkdownMessageProps = {
  content: string;
  className?: string;
};

function isExternalLink(href: string | undefined) {
  return typeof href === "string" && /^(?:[a-z]+:)?\/\//i.test(href);
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
