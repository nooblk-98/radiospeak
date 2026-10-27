import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { MusicBot } from "../src/bots/music-bot.ts";
import { DiscordMusicBot } from "../src/bots/discord/bot.ts";
import { fixture, tracks } from "./helpers.ts";

test("panel creates mixed platform instances, identifies them by logo and edits Discord credentials without exposing tokens", async (t) => {
  const password = "owner-test-password",
    token = "test_discord_bot_token_never_export_123456";
  const f = await fixture(password),
    dom = new JSDOM(readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8"), {
      url: f.base,
      pretendToBeVisual: true,
    });
  t.mock.method(DiscordMusicBot.prototype, "start", async () => {});
  t.mock.method(MusicBot.prototype, "start", async () => {});
  const nativeFetch = globalThis.fetch,
    nativeTimeout = globalThis.setTimeout,
    nativeInterval = globalThis.setInterval,
    timers = new Set<ReturnType<typeof setTimeout>>();
  const keys = [
      "window",
      "document",
      "localStorage",
      "location",
      "requestAnimationFrame",
      "Event",
      "CustomEvent",
      "EventTarget",
      "FormData",
    ],
    descriptors = new Map(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
  const errors: string[] = [];
  dom.window.addEventListener("error", (event) => errors.push(event.message));
  try {
    for (const key of keys)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value:
          key === "requestAnimationFrame"
            ? dom.window.requestAnimationFrame.bind(dom.window)
            : (dom.window as any)[key],
      });
    Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", {
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
    globalThis.setTimeout = ((fn: any, ms: any, ...args: any[]) => {
      const timer = nativeTimeout(fn, ms, ...args);
      timer.unref();
      timers.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.setInterval = ((fn: any, ms: any, ...args: any[]) => {
      const timer = nativeInterval(fn, ms, ...args);
      timer.unref();
      timers.add(timer);
      return timer;
    }) as typeof setInterval;
    globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Basic " + Buffer.from("owner:" + password).toString("base64"));
      return nativeFetch(new URL(String(input), f.base), { ...init, headers });
    };
    const doc = dom.window.document,
      get = (selector: string) => {
        const element = doc.querySelector(selector);
        assert.ok(element, selector + " exists");
        return element as HTMLInputElement;
      };
    const click = (selector: string) => get(selector).click();
    const fill = (selector: string, value: string) => {
      const input = get(selector);
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    const submit = () =>
      get("#modal-form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    const wait = async (predicate: () => boolean, label: string) => {
      const until = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > until)
          throw new Error("UI timeout: " + label + "\n" + doc.body.textContent?.slice(-1800));
        await new Promise((r) => nativeTimeout(r, 25));
      }
    };
    await import("../src/web/app.js");
    await wait(
      () => !!doc.querySelector("#switcher-button .platform-logo"),
      "initial platform logo",
    );
    assert.match(get("#switcher-button .platform-logo").getAttribute("src")!, /teamspeak\.svg/);
    click('[data-action="new-instance"]');
    assert.equal(
      get("#discord-token").disabled,
      true,
      "hidden Discord credentials do not block TeamSpeak form validation",
    );
    get("#instance-platform").value = "discord";
    get("#instance-platform").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(get("#discord-token").disabled, false);
    assert.equal(get("#instance-channel").disabled, true);
    fill("#instance-nickname", "Discord Lounge");
    fill("#instance-id", "discord-lounge");
    fill("#discord-token", token);
    fill("#discord-guild", "123456789012345678");
    fill("#discord-channel", "223456789012345678");
    submit();
    await wait(
      () =>
        f.app.bots.length === 2 &&
        !get("#modal").hasAttribute("open") &&
        !!doc.querySelector('#switcher-button img[src="/discord.svg"]'),
      "Discord instance selected",
    );
    assert.equal(get("#discord-token").value, "", "submitted token is cleared from the dialog");
    assert.match(get("#switcher-button").textContent!, /Discord/);
    assert.match(get(".output-label").textContent!, /Discord/);
    dom.window.location.hash = "settings";
    await wait(() => !!doc.querySelector('[data-action="edit-connection"]'), "Discord settings");
    assert.match(get(".settings-grid").textContent!, /Discord bot/);
    assert.ok(!get(".settings-grid").textContent!.includes("TeamSpeak bot"));
    const discord = f.app.bots[1]!;
    discord.player.pause();
    discord.player.enqueue(tracks);
    discord.player.seek(32);
    const snapshot = discord.player.snapshot();
    click('#view [data-action="edit-connection"]');
    assert.equal(get("#discord-token").value, "");
    fill("#discord-channel", "323456789012345678");
    submit();
    await wait(
      () =>
        f.app.playlists.channelFor("discord-lounge") === "323456789012345678" &&
        !get("#modal").hasAttribute("open"),
      "connection edited",
    );
    assert.deepEqual(f.app.bots[1]!.player.snapshot(), snapshot);
    assert.ok(!doc.body.textContent!.includes(token));
    click('#view [data-action="new-instance"]');
    get("#instance-platform").value = "teamspeak";
    get("#instance-platform").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    fill("#instance-nickname", "TeamSpeak Lobby");
    fill("#instance-id", "ts-lobby");
    submit();
    await wait(
      () =>
        f.app.bots.length === 3 &&
        !get("#modal").hasAttribute("open") &&
        !!doc.querySelector('#switcher-button img[src="/teamspeak.svg"]'),
      "TeamSpeak instance selected",
    );
    assert.equal(f.app.bots[2]!.platform, "teamspeak");
    assert.equal(f.app.bots[2]!.cfg.discord, undefined);
    assert.equal(doc.querySelectorAll(".instance-row .switcher-avatar .platform-logo").length, 3);
    click('#view [data-action="switch-bot"][data-id="Test bot"]');
    await wait(
      () => get("#sidebar-bot").textContent === "Music bot",
      "return to existing instance",
    );
    assert.equal(f.app.bots[0]!.player.queue.length, 3);
    assert.match(get(".output-label").textContent!, /TeamSpeak/);
    assert.deepEqual(errors, []);
    await new Promise((r) => nativeTimeout(r, 100));
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    globalThis.fetch = nativeFetch;
    globalThis.setTimeout = nativeTimeout;
    globalThis.setInterval = nativeInterval;
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
    await f.close();
  }
});
