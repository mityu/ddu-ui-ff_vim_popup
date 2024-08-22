vim9script

export def OpenPopup(optsGiven: dict<any>, exOptProviders: list<list<any>>): number
  const opts = exOptProviders->reduce((curOpts: dict<any>, provider: list<any>): dict<any> => {
    const [fn, args] = provider
    return call(fn, args + [curOpts])
  }, optsGiven)
  return popup_create('', opts)
enddef

export def SetupPopupCallback(denops: string, callback: string, optsGiven: dict<any>): dict<any>
  return {
    callback: (winId: number, _: number) => denops#notify(denops, callback, [winId]),
  }->extend(optsGiven, 'keep')
enddef

export def SetItems(winId: number, items: list<string>, highlights: list<dict<any>>)
  popup_settext(winId, items)

  # TODO: Be async?
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
  redraw  # Sometimes screen is not redrawn immediately.
enddef

