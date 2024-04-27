vim9script

export type MapActionFn = func

const SignCursorName = 'ddu-ui-ff_vim_popup-cursorline'
const SignCursorGroup = 'PopUpDduUiFFVimPopupCursorline'

class UniqueID
  static const nullID = 0
  static var _ID = UniqueID.nullID

  static def GetNewID(): number
    UniqueID._ID += 1
    return UniqueID._ID
  enddef
endclass

export class UiState
  static var _instances: dict<UiState> = {}
  static var configuringInstance: UiState = null_object

  static def Get(id: number): UiState
    return _instances[id]
  enddef

  static def New(uiParams: dict<any>): number
    const id = UniqueID.GetNewID()
    _instances[id] = UiState.new(uiParams)

    configuringInstance = _instances[id]
    try
      autocmd User ddu-ui-ff_vim_popup-open-pre ++once :
      doautocmd User ddu-ui-ff_vim_popup-open-pre
    catch
      EchomsgError(printf("%s\n%s", v:throwpoint, v:exception))
    endtry
    configuringInstance = null_object

    return id
  enddef

  static def Remove(id: number)
    const obj = _instances->remove(id)
    obj._dispose()
  enddef

  var keymapper: dict<any>
  var _actionFns: dict<MapActionFn>
  var _hideCursor: bool
  var _t_ve_save: string

  def new(uiParams: dict<any>)
    this._t_ve_save = &t_ve
    this._hideCursor = uiParams.hideCursor
    this._actionFns = {}
    this.keymapper = vital#ddu_ui_ff_vim_popup#import('Keymapper').new()
    this.keymapper.add_mode('n')
    this.keymapper.add_mode('i', {handle_count: 0})
    this.keymapper.set_mode('n')

    if this._hideCursor
      &t_ve = ''
      redraw
    endif
  enddef

  def _dispose()
    if this._hideCursor
      &t_ve = this._t_ve_save
      redraw
    endif
  enddef

  def OnKeyType(winId: number, key: string): number
    this.keymapper.append_keys(key)
    while true
      var r = this.keymapper.lookup_mapping()
      if r.state == this.keymapper.state.pending
        break
      elseif r.resolved =~# '^action:'
        const uiName = winbufnr(winId)->getbufvar('ddu_ui_name')
        ddu#ui#sync_action(r.resolved[7 :], {count1: r.count1}, uiName)
      elseif r.resolved =~# '^key:'
        const keys = r.resolved[4 :]->ReplaceTermcodes()
        this.keymapper.prepend_keys(keys)
      elseif r.resolved =~# '^fn:'
        call(this._actionFns[r.resolved[3 :]], [])
      else
        const resolved = r.resolved->ReplaceTermcodes()
        if this.keymapper.get_mode() ==# 'i' && resolved =~# '^[[:print:]]\+$'
          const uiName = winbufnr(winId)->getbufvar('ddu_ui_name')
          ddu#ui#sync_action('addChar', {char: resolved}, uiName)
        endif
      endif
    endwhile
    return 1
  enddef

  def MapKey(modes: string, lhs: string, rhs: string)
    for mode in modes
      this.keymapper.add_mapping(mode, lhs, 'key:' .. rhs)
    endfor
  enddef

  def MapAction(modes: string, lhs: string, rhs: string)
    for mode in modes
      this.keymapper.add_mapping(mode, lhs, 'action:' .. rhs)
    endfor
  enddef

  def MapFunction(modes: string, lhs: string, Fn: MapActionFn)
    const name = Fn->get('name')
    const rhs = 'fn:' .. name
    this._actionFns[name] = Fn
    for mode in modes
      this.keymapper.add_mapping(mode, lhs, rhs)
    endfor
  enddef
endclass

export def Invoke(fn: string, args: list<any>): number
  call(fn, args)

  # Return a dummy result.  `Denops.call()` expects that functions must return
  # something.
  return 0
enddef

export def EchomsgError(msg: string)
  echohl Error
  Echomsg(msg)
  echohl None
enddef

export def Echomsg(msg: string)
  for m in msg->split("\n")
    echomsg '[ddu-ui-ff_vim_popup]' m
  endfor
enddef

export def CreateNewUiState(uiParams: dict<any>): number
  return UiState.New(uiParams)
enddef

export def RemoveUiState(id: number)
  UiState.Remove(id)
enddef

def PopupCallback(denops: string, lambda: string, winId: number, result: number)
  denops#notify(denops, lambda, [winId])
enddef

export def RegisterPopupCallback(winId: number, denops: string, lambda: string)
  popup_setoptions(winId, {callback: funcref(PopupCallback, [denops, lambda])})
enddef

export def SetupKeyHandling(uiStateId: number, winId: number)
  popup_setoptions(winId, {
    filter: UiState.Get(uiStateId).OnKeyType,
    filtermode: 'a',
    mapping: false,
  })

  # FIXME: The first typed character will be re-mapped.  As a workaround, send
  # <Ignore> to skip over the first once re-mapping.
  feedkeys("\<Ignore>", 'nit')
enddef

export def SetItems(winId: number, items: list<string>, highlights: list<dict<any>>)
  popup_settext(winId, items)

  # TODO: Be async
  const bufnr = winbufnr(winId)
  prop_clear(1, line('$', winId), {bufnr: bufnr})
  for h in highlights
    if prop_type_get(h.name, {bufnr: bufnr})->empty()
      prop_type_add(h.name, {
        bufnr: bufnr,
        highlight: h.hl_group,
        override: true,
      })
    endif
    prop_add(h.line, h.col, {
      bufnr: bufnr,
      length: h.width,
      type: h.name
    })
  endfor
enddef

export def CallKeymapperMethod(uiStateId: number, method: string, ...args: list<any>): any
  const s = UiState.Get(uiStateId)
  return call(s.keymapper[method], args)
enddef

def ReplaceTermcodes(s: string): string
  return s->substitute('<[^<>]\+>', '\=eval(printf(''"\%s"'', submatch(0)))', 'g')
enddef
