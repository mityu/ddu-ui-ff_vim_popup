vim9script

import './holder.vim' as Holder

export type MapActionFn = func

var sessionId: string

class Session
  static var _holder = Holder.Holder.new()

  var keymapper: dict<any>
  var actionFns: dict<MapActionFn>
  var actionParams: list<any>
  var hideCursor: bool
  var t_ve_save: string

  def new(uiParams: dict<any>)
    this.t_ve_save = &t_ve
    this.hideCursor = uiParams.hideCursor
    this.actionFns = {}
    this.actionParams = []
    this.keymapper = vital#ddu_ui_ff_vim_popup#import('Keymapper').new()
    this.keymapper.add_mode('n')
    this.keymapper.add_mode('i', {handle_count: 0})
    this.keymapper.set_mode('n')

    if this.hideCursor
      &t_ve = ''
      redraw
    endif
  enddef

  def _dispose()
    if this.hideCursor
      &t_ve = this.t_ve_save
      redraw
    endif
  enddef

  static def Add(obj: Session): string
    return _holder.Add(obj)
  enddef

  static def Get(id: string): Session
    return _holder.Get(id)
  enddef

  static def Dispose(id: string)
    const session: Session = _holder.Dispose(id)
    session._dispose()
  enddef
endclass

def OnKeyType(id: string, winId: number, key: string): number
  final session = Session.Get(id)
  session.keymapper.append_keys(key)
  while true
    var r = session.keymapper.lookup_mapping()
    if r.state == session.keymapper.state.pending
      break
    elseif r.resolved =~# '^action:'
      const uiName = winbufnr(winId)->getbufvar('ddu_ui_name')
      const [action, paramIdx] = r.resolved[7 :]->matchlist('^\([^:]*\)\%(:\(.*\)\)\?$')[1 : 2]
      if paramIdx ==# ''
        ddu#ui#sync_action(action, {count1: r.count1}, uiName)
      else
        const userParams = session.actionParams[str2nr(paramIdx)]
        const params = extend({count1: r.count1}, userParams, 'error')
        ddu#ui#sync_action(action, params, uiName)
      endif
    elseif r.resolved =~# '^key:'
      const keys = r.resolved[4 :]->ReplaceTermcodes()
      session.keymapper.prepend_keys(keys)
    elseif r.resolved =~# '^fn:'
      call(session.actionFns[r.resolved[3 :]], [])
    else
      const resolved = r.resolved->ReplaceTermcodes()
      if session.keymapper.get_mode() ==# 'i' && resolved =~# '^[[:print:]]\+$'
        const uiName = winbufnr(winId)->getbufvar('ddu_ui_name')
        ddu#ui#sync_action('addChar', {char: resolved}, uiName)
      endif
    endif
  endwhile
  return 1
enddef

export def CanConfig(): bool
  return sessionId !=# ''
enddef

export def MapKey(modes: string, lhs: string, rhs: string)
  final keymapper = Session.Get(sessionId).keymapper
  for mode in modes
    keymapper.add_mapping(mode, lhs, 'key:' .. rhs)
  endfor
enddef

export def MapAction(modes: string, lhs: string, action: string, params: dict<any>)
  final session = Session.Get(sessionId)
  final keymapper = session.keymapper
  var rhs = 'action:' .. action

  if !empty(params)
    const idx = len(session.actionParams)
    session.actionParams->add(params)
    rhs ..= ':' .. idx
  endif

  for mode in modes
    keymapper.add_mapping(mode, lhs, rhs)
  endfor
enddef

export def MapFunction(modes: string, lhs: string, Fn: MapActionFn)
  final session = Session.Get(sessionId)
  final keymapper = session.keymapper
  const name = Fn->get('name')
  const rhs = 'fn:' .. name
  session.actionFns[name] = Fn
  for mode in modes
    keymapper.add_mapping(mode, lhs, rhs)
  endfor
enddef

export def Unmap(modes: string, lhs: string)
  final session = Session.Get(sessionId)
  for mode in modes
    keymapper.remove_mapping(mode, lhs)
  endfor
enddef

export def CreateNewHandler(uiParams: dict<any>): string
  const id = Session.Add(Session.new(uiParams))
  sessionId = id
  if exists('#User#Ddu:ui:ff_vim_popup:openWindowPre')
    try
      doautocmd User Ddu:ui:ff_vim_popup:openWindowPre
    catch
      ddu#ui#ff_vim_popup#util#EchomsgError($"{v:throwpoint}\n{v:exception}")
    endtry
  endif
  sessionId = ""
  return id
enddef

export def DisposeHandler(id: string)
  Session.Dispose(id)
enddef

export def SetupKeyHandler(id: string, optsGiven: dict<any>): dict<any>
  return {
    filter: function(OnKeyType, [id]),
    filtermode: 'a',
    mapping: false,
  }->extend(optsGiven, 'keep')
enddef

export def SetMode(id: string, mode: string)
  Session.Get(id).keymapper.set_mode(mode)
enddef

export def GetMode(id: string): string
  return Session.Get(id).keymapper.get_mode()
enddef

def ReplaceTermcodes(s: string): string
  return s->substitute('<[^<>]\+>', '\=eval(printf(''"\%s"'', submatch(0)))', 'g')
enddef
