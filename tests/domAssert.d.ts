export {};

declare module "node:assert/strict" {
  interface AssertDomMatcher {
    containsText(text: string): void;
    doesNotContainText(text: string): void;
  }

  interface Assert {
    dom(element: Element | null | undefined): AssertDomMatcher;
    notOk(value: unknown, message?: string): void;
  }

  export function dom(element: Element | null | undefined): AssertDomMatcher;
  export function notOk(value: unknown, message?: string): void;
}
