// Layout trees as data: find a node, or copy the tree with one block's content replaced
// (the bottom panel shows its terminal this way, through layout.set). Pure: tested under node.

export function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

// A deep copy of `tree` where the node `id` has `content` (null when there's no such node).
export function withContent(tree, id, content) {
  let found = false;
  const walk = (n) => {
    const copy = { ...n };
    if (n.id === id) {
      copy.content = content;
      found = true;
    }
    if (Array.isArray(n.children)) copy.children = n.children.map(walk);
    return copy;
  };
  const out = walk(tree);
  return found ? out : null;
}
