import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { parseJson, JsonTree } from "@/components/json-tree"

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  sessionID: string | undefined
  size: Sizing
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const sync = useSync()
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = createMemo(
    () =>
      platform.platform !== "desktop" ||
      import.meta.env.VITE_OPENCODE_CHANNEL !== "beta" ||
      settings.general.showFileTree(),
  )

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(() => isDesktop() && shown() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const [modelIoRes] = createResource(
    () => props.sessionID ?? false,
    (id: string) => sdk.client.session.modelIo({ sessionID: id }).then((r) => r.data ?? []),
  )
  const modelIoItems = createMemo(() => modelIoRes() ?? [])

  const meta = createMemo(() => {
    const first = modelIoItems()[0]
    if (!first) return undefined
    try {
      const req = JSON.parse(first.request)
      return {
        model: req.model as { providerID: string; modelID: string } | undefined,
        agent: req.agent as string | undefined,
      }
    } catch {
      return undefined
    }
  })

  const roundInfo = (item: { request: string; response: string; messageID: string }) => {
    const id = item.messageID.slice(-8)
    try {
      const req = JSON.parse(item.request)
      const res = JSON.parse(item.response)
      const messages = req.messages as Array<{
        role: string
        content: Array<{
          type: string; text?: string; tool?: string; toolName?: string
          toolCallId?: string; output?: { type?: string; value?: string; text?: string }
        }>
      }>
      const parts = res.parts as Array<{
        type: string; tool?: string; text?: string
        state?: { status?: string; input?: unknown }
      }> | undefined

      const lastMsg = messages[messages.length - 1]
      const role = lastMsg?.role ?? "unknown"
      const isToolResult = role === "tool"
      const toolCalls = parts?.filter((p) => p.type === "tool") ?? []

      // Input content from the last message
      let inputContent = ""
      if (isToolResult) {
        const output = lastMsg.content?.[0]?.output
        inputContent = output?.value ?? output?.text ?? ""
        if (!inputContent && output) inputContent = JSON.stringify(output)
      } else {
        const lastUser = messages.filter((m) => m.role === "user").pop()
        inputContent = lastUser?.content?.find((c) => c.type === "text")?.text ?? ""
      }

      // Title for collapsed header
      const lastUser = messages.filter((m) => m.role === "user").pop()
      const userText = lastUser?.content?.find((c) => c.type === "text")?.text
      const fullTitle = userText ?? (
        toolCalls.length ? toolCalls.map((t) => t.tool).filter(Boolean).join(", ")
        : isToolResult ? (lastMsg.content?.[0]?.toolName ?? "Tool result")
        : `Round ${id}`
      )
      const title = fullTitle.length > 60 ? fullTitle.slice(0, 60) + "…" : fullTitle
      const displayParts = parts?.filter((p) => p.type !== "step-start" && p.type !== "step-finish") ?? []

      return {
        icon: isToolResult ? ("tool_result" as const) : ("user" as const),
        title, fullTitle,
        toolNames: toolCalls.length ? toolCalls.map((t) => t.tool).filter(Boolean).join(", ") : undefined,
        role, inputContent,
        contextCount: Math.max(0, messages.length - 1),
        outputParts: displayParts,
        finish: res.finish as string | undefined,
        id, messageID: item.messageID,
      }
    } catch {
      return {
        icon: "user" as const, title: `Round ${id}`, fullTitle: `Round ${id}`,
        role: "unknown", inputContent: "", contextCount: 0, outputParts: [],
        id, messageID: item.messageID,
      }
    }
  }

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const [openRoundID, setOpenRoundID] = createSignal<string | null>(null)

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={openTab}>
                  <div class="sticky top-0 shrink-0 flex">
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={reviewTab() && props.canReview()}>
                        <Tabs.Trigger value="review">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.review")}</div>
                            <Show when={props.hasReview()}>
                              <div>{props.reviewCount()}</div>
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={reviewTab() && !!props.sessionID}>
                        <Tabs.Trigger value="modelView">
                          <div class="flex items-center gap-1.5">Model View</div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                      </SortableProvider>
                      <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                        <TooltipKeybind
                          title={language.t("command.file.open")}
                          keybind={command.keybind("file.open")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            onClick={() => {
                              void import("@/components/dialog-select-file").then((x) => {
                                dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                              })
                            }}
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </div>
                    </Tabs.List>
                  </div>

                  <Show when={reviewTab() && props.canReview()}>
                    <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={reviewTab() && !!props.sessionID}>
                    <Tabs.Content value="modelView" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "modelView"}>
                        <div class="h-full overflow-auto p-3 font-mono text-11 select-text">
                          <Show when={modelIoItems().length > 0} fallback={
                            <div class="text-text-weak p-4 text-center">No model I/O yet. Send a message first.</div>
                          }>
                            <Show when={meta()}>{(m) => (
                              <div class="mb-3 p-2 bg-background-base rounded border border-border-base space-y-1">
                                <div class="flex items-center gap-2"><span class="text-text-weak">Session</span><span class="text-text-base font-medium">{props.sessionID}</span></div>
                                <Show when={m().model}><div class="flex items-center gap-2"><span class="text-text-weak">Model</span><span class="text-text-base">{m().model!.providerID}/{m().model!.modelID}</span></div></Show>
                                <Show when={m().agent}><div class="flex items-center gap-2"><span class="text-text-weak">Agent</span><span class="text-text-base">{m().agent}</span></div></Show>
                                <div class="flex items-center gap-2"><span class="text-text-weak">Rounds</span><span class="text-text-base">{modelIoItems().length}</span></div>
                              </div>
                            )}</Show>
                            <For each={modelIoItems()}>
                              {(item) => {
                                const info = roundInfo(item)
                                const isOpen = () => openRoundID() === item.messageID
                                const toggle = () => setOpenRoundID(openRoundID() === item.messageID ? null : item.messageID)
                                const kindTip = () => info.icon === "tool_result" ? `Tool result: ${info.fullTitle}` : "User input"
                                return (
                                  <div class="mb-2 border border-border-base rounded">
                                    <div class="px-2 py-1 bg-background-strong cursor-pointer flex items-center gap-1 hover:bg-background-stronger" onClick={toggle}>
                                      <span class="text-text-weak select-none shrink-0">{isOpen() ? "▾" : "▸"}</span>
                                      <Tooltip value={kindTip()} placement="top" gutter={4} openDelay={0} closeDelay={500}>
                                        <span>{info.icon === "tool_result" ? <span class="text-[#7c3aed] text-10">↩</span> : <span class="text-text-weak text-10">👤</span>}</span>
                                      </Tooltip>
                                      <Tooltip value={info.fullTitle} placement="top" gutter={4} openDelay={0} closeDelay={500}>
                                        <span class="text-text-base truncate" classList={{"text-text-weak": !info.role || info.role === "unknown"}}>{info.title}</span>
                                      </Tooltip>
                                      <Show when={info.toolNames}>
                                        <Tooltip value={`Tool: ${info.toolNames}`} placement="top" gutter={4} openDelay={0} closeDelay={500}>
                                          <span class="text-[#d97706] text-10 shrink-0 ml-1 cursor-default">🔧 {info.toolNames}</span>
                                        </Tooltip>
                                      </Show>
                                      <Tooltip value={`Message ID: ${info.messageID}`} placement="top" gutter={4} class="ml-auto" openDelay={0} closeDelay={500}>
                                        <span class="text-text-weak/50 text-8 shrink-0">{info.id}</span>
                                      </Tooltip>
                                    </div>
                                    <Show when={isOpen()}>
                                      <div class="p-3 space-y-3 border-t border-border-base">
                                        <div>
                                          <div class="text-text-weak/50 text-9 font-medium mb-1">INPUT</div>
                                          <div class="space-y-1">
                                            <div class="flex items-start gap-2">
                                              <span class="text-text-weak shrink-0 w-14">Role</span>
                                              <span class="text-text-base">{info.role}</span>
                                            </div>
                                            <Show when={info.contextCount > 0}>
                                              <div class="flex items-start gap-2">
                                                <span class="text-text-weak shrink-0 w-14">Context</span>
                                                <span class="text-text-base">{info.contextCount} previous message(s)</span>
                                              </div>
                                            </Show>
                                            <div class="flex items-start gap-2">
                                              <span class="text-text-weak shrink-0 w-14">Content</span>
                                              <div class="min-w-0">
                                                <pre class="text-text-base whitespace-pre-wrap break-all max-h-48 overflow-auto">{info.inputContent}</pre>
                                              </div>
                                            </div>
                                          </div>
                                          <details class="mt-2">
                                            <summary class="text-text-weak cursor-pointer text-10">Raw Request</summary>
                                            <div class="mt-1 bg-background-base rounded p-2 max-h-72 overflow-auto"><JsonTree value={parseJson(item.request)} /></div>
                                          </details>
                                        </div>
                                        <div>
                                          <div class="text-text-weak/50 text-9 font-medium mb-1">OUTPUT</div>
                                          <div class="space-y-2">
                                            <For each={info.outputParts}>
                                              {(p) => (
                                                <Show when={p.type !== "step-start" && p.type !== "step-finish"}>
                                                  <div class="flex items-start gap-2">
                                                    <span class="text-text-weak shrink-0 w-14">{p.type === "tool" ? "Tool call" : p.type}</span>
                                                    <div class="min-w-0">
                                                      <Show when={p.type === "text"}>
                                                        <pre class="text-text-base whitespace-pre-wrap break-all">{p.text}</pre>
                                                      </Show>
                                                      <Show when={p.type === "reasoning"}>
                                                        <pre class="text-text-weak/70 whitespace-pre-wrap break-all italic">{p.text}</pre>
                                                      </Show>
                                                      <Show when={p.type === "tool"}>
                                                        <div class="text-[#d97706] font-medium">🔧 {p.tool}</div>
                                                        <Show when={p.state?.input}>
                                                          <pre class="text-text-base text-10 whitespace-pre-wrap break-all mt-0.5">{JSON.stringify(p.state!.input, null, 2)}</pre>
                                                        </Show>
                                                      </Show>
                                                    </div>
                                                  </div>
                                                </Show>
                                              )}
                                            </For>
                                            <Show when={info.finish}>
                                              <div class="flex items-start gap-2">
                                                <span class="text-text-weak shrink-0 w-14">Finish</span>
                                                <span class="text-text-base">{info.finish}</span>
                                              </div>
                                            </Show>
                                            <details class="mt-2">
                                              <summary class="text-text-weak cursor-pointer text-10">Raw Response</summary>
                                              <div class="mt-1 bg-background-base rounded p-2 max-h-72 overflow-auto"><JsonTree value={parseJson(item.response)} /></div>
                                            </details>
                                          </div>
                                        </div>
                                      </div>
                                    </Show>
                                  </div>
                                )
                              }}
                            </For>
                            </Show>
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "empty"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                          <Mark class="w-14 opacity-10" />
                          <div class="text-14-regular text-text-weak max-w-56">
                            {language.t("session.files.selectToOpen")}
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Tabs.Content>

                  <Show when={contextOpen()}>
                    <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "context"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <SessionContextTab />
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={activeFileTab()} keyed>
                    {(tab) => <FileTabContent tab={tab} />}
                  </Show>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = file.pathFromTab(tab)
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>

          <Show when={shown()}>
            <div
              id="file-tree-panel"
              aria-hidden={!fileOpen()}
              inert={!fileOpen()}
              class="relative min-w-0 h-full shrink-0 overflow-hidden"
              classList={{
                "pointer-events-none": !fileOpen(),
                "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !props.size.active(),
              }}
              style={{ width: treeWidth() }}
            >
              <div
                class="h-full flex flex-col overflow-hidden group/filetree"
                classList={{ "border-l border-border-weaker-base": reviewOpen() }}
              >
                <Tabs
                  variant="pill"
                  value={fileTreeTab()}
                  onChange={setFileTreeTabValue}
                  class="h-full"
                  data-scope="filetree"
                >
                  <Tabs.List>
                    <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                      {props.reviewCount()}{" "}
                      {language.t(
                        props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                      )}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                      {language.t("session.files.all")}
                    </Tabs.Trigger>
                  </Tabs.List>
                  <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={props.hasReview() || !props.diffsReady()}>
                        <Show
                          when={props.diffsReady()}
                          fallback={
                            <div class="px-2 py-2 text-12-regular text-text-weak">
                              {language.t("common.loading")}
                              {language.t("common.loading.ellipsis")}
                            </div>
                          }
                        >
                          <FileTree
                            path=""
                            class="pt-3"
                            allowed={diffFiles()}
                            kinds={kinds()}
                            draggable={false}
                            active={props.activeDiff}
                            onFileClick={(node) => props.focusReviewDiff(node.path)}
                          />
                        </Show>
                      </Match>
                    </Switch>
                  </Tabs.Content>
                  <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                    <Switch>
                      <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                      <Match when={true}>
                        <FileTree
                          path=""
                          class="pt-3"
                          modified={diffFiles()}
                          kinds={kinds()}
                          onFileClick={(node) => openTab(file.tab(node.path))}
                        />
                      </Match>
                    </Switch>
                  </Tabs.Content>
                </Tabs>
              </div>
              <Show when={fileOpen()}>
                <div onPointerDown={() => props.size.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={layout.fileTree.width()}
                    min={200}
                    max={480}
                    onResize={(width) => {
                      props.size.touch()
                      layout.fileTree.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}
