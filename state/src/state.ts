import {Text} from "../../text"
import {EditorSelection} from "./selection"
import {Transaction} from "./transaction"
import {Syntax} from "./extension"
import {Configuration, Facet, Extension, StateField, SlotStatus, ensureAddr, getAddr, initState} from "./facet"

/// Options passed when [creating](#state.EditorState^create) an
/// editor state.
export interface EditorStateConfig {
  /// The initial document. Defaults to an empty document. Can be
  /// provided either as a plain string (which will be split into
  /// lines according to the value of the [`lineSeparator`
  /// behavior](#state.EditorState^lineSeparator)), or an instance of
  /// the [`Text`](#text.Text) class (which is what the state will use
  /// to represent the document).
  doc?: string | Text
  /// The starting selection. Defaults to a cursor at the very start
  /// of the document.
  selection?: EditorSelection
  /// [State](#state.EditorState^extend) or
  /// [view](#view.EditorView^extend) extensions to associate with
  /// this state. View extensions provided here only take effect when
  /// the state is put into an editor view.
  extensions?: Extension
}

const DEFAULT_INDENT_UNIT = 2, DEFAULT_TABSIZE = 4, DEFAULT_SPLIT = /\r\n?|\n/

/// The editor state class is a persistent (immutable) data structure.
/// To update a state, you [create](#state.EditorState.t) and
/// [apply](#state.Transaction.apply) a
/// [transaction](#state.Transaction), which produces a _new_ state
/// instance, without modifying the original object.
///
/// As such, _never_ mutate properties of a state directly. That'll
/// just break things.
export class EditorState {
  /// @internal
  readonly values: any[]
  /// @internal
  readonly status: SlotStatus[]
  /// @internal
  applying: null | Transaction = null

  /// @internal
  constructor(
    /// @internal
    readonly config: Configuration,
    /// The current document.
    readonly doc: Text,
    /// The current selection.
    readonly selection: EditorSelection,
    values?: any[]
  ) {
    for (let range of selection.ranges)
      if (range.to > doc.length) throw new RangeError("Selection points outside of document")
    this.status = config.dynamicSlots.map(_ => SlotStatus.Uninitialized)
    this.values = values ? values.slice() : config.dynamicSlots.map(_ => null)
  }

  /// Retrieve the value of a [state field](#state.StateField). Throws
  /// an error when the state doesn't have that field, unless you pass
  /// `false` as second parameter.
  field<T>(field: StateField<T>): T
  field<T>(field: StateField<T>, require: false): T | undefined
  field<T>(field: StateField<T>, require: boolean = true): T | undefined {
    let addr = this.config.address[field.id]
    if (addr == null) {
      if (require) throw new RangeError("Field is not present in this state")
      return undefined
    }
    ensureAddr(this, addr)
    return getAddr(this, addr)
  }

  /// Start a new transaction from this state. When not given, the
  /// timestamp defaults to
  /// [`Date.now()`](https://developer.mozilla.org/en-US/docs/JavaScript/Reference/Global_Objects/Date/now).
  t(timestamp?: number): Transaction {
    return new Transaction(this, timestamp)
  }

  /// Join an array of lines using the state's [line
  /// separator](#state.EditorState^lineSeparator).
  joinLines(text: readonly string[]): string { return text.join(this.facet(EditorState.lineSeparator) || "\n") }

  /// Split a string into lines using the state's [line
  /// separator](#state.EditorState^lineSeparator).
  splitLines(text: string): string[] { return text.split(this.facet(EditorState.lineSeparator) || DEFAULT_SPLIT) }

  /// Get the value of a state [behavior](#extension.Behavior).
  facet<Output>(facet: Facet<any, Output>): Output {
    let addr = this.config.address[facet.id]
    if (addr == null) return facet.default
    ensureAddr(this, addr)
    return getAddr(this, addr)
  }

  /// Convert this state to a JSON-serializable object.
  toJSON(): any {
    // FIXME plugin state serialization
    return {
      doc: this.joinLines(this.doc.sliceLines(0, this.doc.length)),
      selection: this.selection.toJSON()
    }
  }

  /// Deserialize a state from its JSON representation.
  static fromJSON(json: any, config: EditorStateConfig = {}): EditorState {
    if (!json || typeof json.doc != "string")
      throw new RangeError("Invalid JSON representation for EditorState")
    return EditorState.create({
      doc: json.doc,
      selection: EditorSelection.fromJSON(json.selection),
      extensions: config.extensions
    })
  }

  /// @internal
  applyTransaction(tr: Transaction): EditorState {
    let start: EditorState = this, config = start.config
    if (tr.reconfigureExt) { // FIXME this is broken
      let config = Configuration.resolve(tr.reconfigureExt)
      start = initState(new EditorState(config, start.doc, start.selection), null)
    }
    return initState(new EditorState(config, tr.doc, tr.selection, start.values), tr)
  }

  /// Create a new state. You'll usually only need this when
  /// initializing an editor—updated states are created by applying
  /// transactions.
  static create(config: EditorStateConfig = {}): EditorState {
    let configuration = Configuration.resolve(config.extensions || [])
    let doc = config.doc instanceof Text ? config.doc
      : Text.of((config.doc || "").split(configuration.staticFacet(EditorState.lineSeparator) || DEFAULT_SPLIT))
    let selection = config.selection || EditorSelection.single(0)
    if (!configuration.staticFacet(EditorState.allowMultipleSelections)) selection = selection.asSingle()
    return initState(new EditorState(configuration, doc, selection), null)
  }

  /// A facet that, when enabled, causes the editor to allow multiple
  /// ranges to be selected. You should probably not use this
  /// directly, but let a plugin like
  /// [multiple-selections](#multiple-selections) handle it (which
  /// also makes sure the selections are visible in the view).
  static allowMultipleSelections = Facet.define<boolean, boolean>({
    combine: values => values.some(v => v),
    static: true
  })

  /// Facet that defines a way to query for automatic indentation
  /// depth at the start of a given line.
  static indentation = Facet.define<(state: EditorState, pos: number) => number>()

  /// Configures the tab size to use in this state. The first
  /// (highest-precedence) value of the behavior is used.
  static tabSize = Facet.define<number, number>({
    combine: values => values.length ? values[0] : DEFAULT_TABSIZE
  })

  /// The size (in columns) of a tab in the document, determined by
  /// the [`tabSize`](#state.EditorState^tabSize) behavior.
  get tabSize() { return this.facet(EditorState.tabSize) }

  /// The line separator to use. By default, any of `"\n"`, `"\r\n"`
  /// and `"\r"` is treated as a separator when splitting lines, and
  /// lines are joined with `"\n"`.
  ///
  /// When you configure a value here, only that precise separator
  /// will be used, allowing you to round-trip documents through the
  /// editor without normalizing line separators.
  static lineSeparator = Facet.define<string, string | undefined>({
    combine: values => values.length ? values[0] : undefined,
    static: true
  })

  /// Facet for overriding the unit (in columns) by which
  /// indentation happens. When not set, this defaults to 2.
  static indentUnit = Facet.define<number, number>({
    combine: values => values.length ? values[0] : DEFAULT_INDENT_UNIT
  })

  /// The size of an indent unit in the document. Determined by the
  /// [`indentUnit`](#state.EditorState^indentUnit) facet.
  get indentUnit() { return this.facet(EditorState.indentUnit) }

  /// Facet that registers a parsing service for the state.
  static syntax = Facet.define<Syntax>()

  /// A facet that registers a code folding service. When called
  /// with the extent of a line, it'll return a range object when a
  /// foldable that starts on that line (but continues beyond it) can
  /// be found.
  static foldable = Facet.define<(state: EditorState, lineStart: number, lineEnd: number) => ({from: number, to: number} | null)>()
}
