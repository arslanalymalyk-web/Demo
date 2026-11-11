// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../apps/web/src/ErrorBoundary.js";
import { setLang } from "../../apps/web/src/i18n.js";

afterEach(() => { cleanup(); setLang("en"); });
let explode = true;
const Bomb = () => { if (explode) throw new Error("secret internal detail"); return <p>drawn fine</p>; };

describe("a screen that fails to draw", () => {
  it("tells the person in words, shows nothing of the error, and can try again", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    explode = true;
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("This screen could not be shown.");
    expect(document.body.textContent).not.toContain("secret internal detail");
    expect(screen.getByRole("link", { name: "Back to the Command Centre" }).getAttribute("href")).toBe("#/");
    explode = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("drawn fine")).toBeTruthy();
    spy.mockRestore();
  });
  it("speaks Arabic when the interface is in Arabic", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setLang("ar"); explode = true;
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("تعذّر عرض هذه الشاشة.");
    spy.mockRestore();
  });
});
