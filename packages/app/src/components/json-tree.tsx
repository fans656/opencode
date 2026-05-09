import { For, Show, createSignal, type JSX } from "solid-js"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function isObject(val: JsonValue): val is Record<string, JsonValue> {
  return val !== null && typeof val === "object" && !Array.isArray(val)
}

function ToggleArrow(props: { expanded: boolean; onClick: () => void }) {
  return (
    <span class="cursor-pointer select-none text-text-weak mr-1" onClick={props.onClick}>
      {props.expanded ? "▾" : "▸"}
    </span>
  )
}

function LongString(props: { value: string; maxLen?: number }) {
  const max = props.maxLen ?? 120
  const short = props.value.length <= max
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLSpanElement | undefined

  return (
    <>
      <span
        ref={trigger}
        class="text-[#059669] inline-block max-w-xs overflow-hidden text-ellipsis whitespace-nowrap align-bottom"
        title={short ? undefined : props.value}
        onMouseEnter={() => !short && setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {props.value}
      </span>
      <Show when={open() && !short}>
        <div
          class="absolute z-50 bg-background-strong border border-border-base rounded shadow-lg p-2 max-w-lg max-h-64 overflow-auto text-[#059669] font-mono text-11 leading-relaxed whitespace-pre-wrap"
          style={{
            top: (trigger?.getBoundingClientRect().bottom ?? 0) + 4 + "px",
            left: (trigger?.getBoundingClientRect().left ?? 0) + "px",
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {props.value}
        </div>
      </Show>
    </>
  )
}

function Node(props: { key?: string; value: JsonValue; depth: number; parent?: string }): JSX.Element {
  const [expanded, setExpanded] = createSignal(props.depth < 2)
  const indent = () => "  ".repeat(props.depth)
  const prefix = () => (props.key !== undefined ? `"${props.key}": ` : "")

  if (props.value === null) return <span class="text-[#7c3aed]">{prefix()}null</span>
  if (typeof props.value === "boolean") return <span class="text-[#7c3aed]">{prefix()}{String(props.value)}</span>
  if (typeof props.value === "number") return <span class="text-[#2563eb]">{prefix()}{props.value}</span>
  if (typeof props.value === "string") {
    return (
      <span>
        <span class="text-[#059669]">{prefix()}"</span>
        <LongString value={props.value} />
        <span class="text-[#059669]">"</span>
      </span>
    )
  }

  if (Array.isArray(props.value)) {
    const toggle = () => setExpanded(!expanded())
    return (
      <span>
        <ToggleArrow expanded={expanded()} onClick={toggle} />
        {prefix()}[
        {expanded() ? (
          <div class="pl-4">
            <For each={props.value}>
              {(item, i) => (
                <div>
                  {indent()}
                  <Node value={item} depth={props.depth + 1} />
                  {i() < props.value.length - 1 ? "," : null}
                </div>
              )}
            </For>
          </div>
        ) : (
          <span class="text-text-weak cursor-pointer hover:text-text-base" onClick={toggle}>
            {props.value.length} items
          </span>
        )}
        ]
      </span>
    )
  }

  // Object
  const entries = Object.entries(props.value)
  const toggle = () => setExpanded(!expanded())
  return (
    <span>
      <ToggleArrow expanded={expanded()} onClick={toggle} />
      {prefix()}{"{"}
      {expanded() ? (
        <div class="pl-4">
          <For each={entries}>
            {([key, val], i) => (
              <div>
                {indent()}
                <Node key={key} value={val} depth={props.depth + 1} />
                {i() < entries.length - 1 ? "," : null}
              </div>
            )}
          </For>
        </div>
      ) : (
        <span class="text-text-weak cursor-pointer hover:text-text-base" onClick={toggle}>
          {entries.length} keys
        </span>
      )}
      {"}"}
    </span>
  )
}

export function JsonTree(props: { value: JsonValue; class?: string }) {
  return (
    <div class={`font-mono text-11 leading-relaxed relative ${props.class ?? ""}`}>
      <Node value={props.value} depth={0} />
    </div>
  )
}

export function parseJson(raw: string): JsonValue {
  return JSON.parse(raw)
}
