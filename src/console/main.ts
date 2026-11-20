/** The browser's entry: the page, given the one way it reaches data, a GET to this service. */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.ts";
import { BadRequestError } from "./read.ts";

async function get(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = (await response.json()) as { message?: string };
  if (response.status === 400) throw new BadRequestError(body.message ?? "the service rejected the request");
  if (!response.ok) throw new Error(`${response.status}: ${body.message ?? "the service did not answer"}`);
  return body;
}

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root element to draw into");
createRoot(root).render(createElement(App, { get }));
