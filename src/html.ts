import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface HtmlOptions {
	extractMainContent?: boolean;
}

export interface HtmlResult {
	title: string;
	content: string;
	extractedMainContent: boolean;
}

function resolveUrl(value: string, baseUrl: string, image = false): string | null {
	try {
		const url = new URL(value, baseUrl);
		const allowed = image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"];
		return allowed.includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

/** Parse only: no page scripts execute and no subresources are fetched. */
export function htmlToMarkdown(html: string, url: string, options: HtmlOptions = {}): HtmlResult {
	// Linkedom does not synthesize a body for HTML fragments.
	const source = /<html\b|<body\b/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`;
	const { document } = parseHTML(source);
	const title = document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() || "Untitled";
	const baseHref = document.querySelector("base[href]")?.getAttribute("href");
	const baseUrl = (baseHref && resolveUrl(baseHref, url)) || url;

	for (const node of document.querySelectorAll("script, style, svg, noscript, template, iframe, object, embed, [hidden], [aria-hidden='true']")) {
		node.remove();
	}
	// Resolve relative URLs before extraction, including after HTTP redirects.
	for (const node of document.querySelectorAll("a[href], img[src]")) {
		const attr = node.localName === "a" ? "href" : "src";
		const resolved = resolveUrl(node.getAttribute(attr) || "", baseUrl, attr === "src");
		if (resolved) node.setAttribute(attr, resolved);
		else node.removeAttribute(attr);
	}

	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		preformattedCode: true,
	});
	turndown.use(gfm);
	// GFM's stock table rule keeps headerless tables as raw HTML and cannot
	// handle empty tables. Convert all tables without dropping the first data row.
	turndown.addRule("readableTables", {
		filter: "table",
		replacement(_content, node) {
			const rows = Array.from(node.querySelectorAll("tr"))
				.filter((row) => row.closest("table") === node)
				.map((row) => Array.from(row.children).filter((cell) => /^(TH|TD)$/.test(cell.nodeName)));
			const width = Math.max(0, ...rows.map((row) => row.length));
			if (!width) return "";
			const formatRow = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] || "").join(" | ")} |`;
			const values = rows.map((row) => row.map((cell) => turndown.turndown(cell.innerHTML).trim()
				.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|")));
			const hasHeader = rows[0].every((cell) => cell.nodeName === "TH") || rows[0][0]?.parentElement?.parentElement?.nodeName === "THEAD";
			const header = hasHeader ? values.shift()! : [];
			return `\n\n${[formatRow(header), formatRow(Array(width).fill("---")), ...values.map(formatRow)].join("\n")}\n\n`;
		},
	});
	const wholePage = document.body.innerHTML;
	let content = "";
	let extractedMainContent = false;
	let extractedTitle = "";
	if (options.extractMainContent !== false) {
		try {
			// Readability mutates its input; keep the original for whole-page fallback.
			const clone = document.cloneNode(true);
			Object.defineProperties(clone, {
				documentURI: { value: url, configurable: true },
				baseURI: { value: baseUrl, configurable: true },
			});
			// Code language/highlight classes are needed by the Markdown converter.
			const article = new Readability(clone, { maxElemsToParse: 50_000, keepClasses: true }).parse();
			if (article?.content && article.textContent?.trim()) {
				content = turndown.turndown(article.content).trim();
				if (content) {
					extractedMainContent = true;
					extractedTitle = article.title?.trim() || "";
				}
			}
		} catch {
			// Non-article pages and extraction failures still return readable Markdown.
		}
	}
	if (!content) content = turndown.turndown(wholePage).trim();
	return { title: extractedTitle || title, content, extractedMainContent };
}
