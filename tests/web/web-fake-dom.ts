// Just enough of a DOM for react-dom to mount, hide and remove elements.
export class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeValue: string | null = null;
  constructor(
    public nodeType: number,
    public nodeName: string,
    public ownerDocument: FakeNode | null,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3
      ? (this.nodeValue ?? '')
      : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(textNode(this.ownerDocument, text));
  }
  appendChild(child: FakeNode) {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener() {}
  removeEventListener() {}
}
export class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  dataset: Record<string, string> = {};
  classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  style: Record<string, unknown> = {
    setProperty(name: string, value: string) {
      this[name] = value;
    },
    removeProperty(name: string) {
      delete this[name];
    },
  };
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
}
const textNode = (doc: FakeNode | null, text: string) => {
  const node = new FakeNode(3, '#text', doc);
  node.nodeValue = text;
  return node;
};
/** Builds every element, its root and body included, from `Element`. */
export class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  body: FakeElement;
  activeElement = null;
  defaultView: unknown = null;
  private Element: typeof FakeElement;
  constructor(Element = FakeElement) {
    super(9, '#document', null);
    this.Element = Element;
    this.documentElement = new Element(1, 'HTML', this);
    this.body = new Element(1, 'BODY', this);
  }
  createElement(tag: string) {
    return new this.Element(1, tag.toUpperCase(), this);
  }
  createElementNS(namespace: string, tag: string) {
    return Object.assign(new this.Element(1, tag, this), { namespaceURI: namespace });
  }
  createTextNode(text: string) {
    return textNode(this, text);
  }
  getElementById() {
    return null;
  }
}
