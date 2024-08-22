vim9script

import './ff_vim_popup/keyhandler.vim' as Keyhandler
import './ff_vim_popup/util.vim' as Util

def CheckMappableState(silent: bool = false): bool
  if !Keyhandler.CanConfig()
    if !silent
      Util.EchomsgError(
        'Mapping functions are must be called while ddu-ui-ff_vim_popup-open-pre event.')
    endif
    return false
  endif
  return true
enddef

export def MapKey(modes: string, lhs: string, rhs: string)
  if !CheckMappableState()
    return
  endif
  Keyhandler.MapKey(modes, lhs, rhs)
enddef

export def MapAction(modes: string, lhs: string, action: string, params: dict<any> = {})
  if !CheckMappableState()
    return
  endif
  Keyhandler.MapAction(modes, lhs, action, params)
enddef

export def MapFunction(modes: string, lhs: string, Fn: Keyhandler.MapActionFn)
  if !CheckMappableState()
    return
  endif
  Keyhandler.MapFunction(modes, lhs, Fn)
enddef

export def Unmap(modes: string, lhs: string)
  if !CheckMappableState()
    return
  endif
  Keyhandler.Unmap(modes, lhs)
enddef
