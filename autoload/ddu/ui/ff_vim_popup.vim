vim9script

import './ff_vim_popup/internal.vim' as Internal

def CheckMappableState(silent: bool = false): bool
  if Internal.UiState.configuringInstance == null_object
    if !silent
      Internal.EchomsgError(
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
  Internal.UiState.configuringInstance.MapKey(modes, lhs, rhs)
enddef

export def MapAction(modes: string, lhs: string, action: string)
  if !CheckMappableState()
    return
  endif
  Internal.UiState.configuringInstance.MapAction(modes, lhs, action)
enddef

export def MapFunction(modes: string, lhs: string, Fn: Internal.MapActionFn)
  if !CheckMappableState()
    return
  endif
  Internal.UiState.configuringInstance.MapFunction(modes, lhs, Fn)
enddef
