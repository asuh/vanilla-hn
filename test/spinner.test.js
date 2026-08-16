import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.style = {};
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

globalThis.document = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

const { createSpinner } = await import("../src/components/Spinner.js");

test("createSpinner renders an accessible three-dot spinner", () => {
  const spinner = createSpinner({
    inline: true,
    size: "20px",
    label: "Loading comment",
  });

  assert.equal(spinner.tagName, "SPAN");
  assert.equal(spinner.attributes.get("class"), "spinner");
  assert.equal(spinner.attributes.get("role"), "status");
  assert.equal(spinner.attributes.get("aria-label"), "Loading comment");
  assert.equal(spinner.children.length, 3);

  spinner.children.forEach((dot, index) => {
    assert.equal(dot.attributes.get("class"), `bounce${index + 1}`);
    assert.equal(dot.style.width, "20px");
    assert.equal(dot.style.height, "20px");
  });
});

test("loading views use the shared spinner component", async () => {
  const files = [
    "src/components/PollOption.js",
    "src/views/ItemView.js",
    "src/views/NewCommentsView.js",
    "src/views/PermalinkedCommentView.js",
    "src/views/UserView.js",
  ];

  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /createSpinner\s*\(/, `${file} should call createSpinner()`);
    assert.doesNotMatch(
      source,
      /create\(["']span["'],\s*\{\s*attrs:\s*\{\s*class:\s*["']spinner["']/,
      `${file} should not render an empty spinner shell`,
    );
  }
});
