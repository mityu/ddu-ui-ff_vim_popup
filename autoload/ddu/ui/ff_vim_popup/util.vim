vim9script

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

export def Search(winId: number, pattern: string): number
  return win_execute(winId, $'echo search({pattern->string()->string()}, "wn")')
    ->matchstr('\d\+')->str2nr()
enddef
