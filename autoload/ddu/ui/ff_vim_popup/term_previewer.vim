vim9script

const useTrueColor = has('gui_running') || &termguicolors

class Debounce
  var _timer: number

  def new()
    this._timer = 0
  enddef

  def Queue(wait: number, F: func, args: list<any>)
    timer_stop(this._timer)
    this._timer = timer_start(wait, (timer: number) => call(F, args))
  enddef
endclass

export def DoPreview(popupId: number, cmds: list<string>, optsGiven: dict<any>): number
  const debounce = Debounce.new()
  var termbufnr = 0
  const opts = {
    hidden: true,
    callback: (ch: channel, msg: string) =>
      debounce.Queue(20, UpdateDisplay, [termbufnr, popupId]),
    close_cb: (ch: channel) => execute($':{termbufnr}bwipeout!'),
  }->extend(optsGiven, 'keep')
  termbufnr = term_start(cmds, opts)
  return termbufnr
enddef

export def StopPreview(termbufnr: number)
  const job = term_getjob(termbufnr)
  if job != null_job
    job_stop(job)
  endif
enddef

def UpdateDisplay(termbufnr: number, popupId: number)
  if !bufexists(termbufnr) || getbufvar(termbufnr, '&buftype') !=# 'terminal'
    return
  endif

  const bufnr = winbufnr(popupId)
  if bufnr == -1
    return  # Preview popup is already closed.
  endif

  const [rows, cols] = term_getsize(termbufnr)
  const texts = range(0, rows)
    ->mapnew((i: number, _: number) => term_getline(termbufnr, i + 1))
    ->map((_: number, text: string) => text .. repeat(' ', cols - strdisplaywidth(text)))
  popup_settext(popupId, texts)

  const [decorations, highlights] =
    GetDecorationsFromAnnotations(termbufnr, GetAnnotations(termbufnr))

  hlset(highlights->values())
  for deco in decorations
    if prop_type_get(deco.type, {bufnr: bufnr})->empty()
      prop_type_add(deco.type, {
        bufnr: bufnr,
        highlight: deco.highlight,
        override: true,
      })
    endif
    prop_add(deco.line, deco.col, {
      bufnr: bufnr,
      type: deco.type,
      length: deco.len,
    })
  endfor
enddef

def GetDecorationsFromAnnotations(termbufnr: number, annons: list<dict<any>>): list<any>
  var decorations: list<dict<any>> = []
  var highlights: dict<dict<any>> = {}

  const attrs = ["bold", "italic", "underline", "strike", "reverse"]
  for annon in annons
    var attr: dict<bool> = {}
    for what in attrs
      attr[what] = term_getattr(annon.attr, what) != 0
    endfor

    const hlgroup = GetHighlightName(annon, attr)
    decorations->add({
      line: annon.row,
      col: annon.col,
      len: annon.width,
      highlight: hlgroup,
      type: $'prop-ddu-ui-ff-vim-popup-{hlgroup}'
    })
    if !highlights->has_key(hlgroup)
      highlights[hlgroup] = GetHighlightDict(hlgroup, annon, attr)
    endif
  endfor

  # Convert gui colors into cterm colors.
  if !useTrueColor
    const colorMap = GetColorMap(termbufnr)
    highlights->foreach((_: string, highlight: dict<any>): void => {
      highlight.ctermfg = colorMap[highlight.guifg]
      highlight.ctermbg = colorMap[highlight.guibg]
      highlight->remove('guifg')
      highlight->remove('ctermfg')
    })
  endif

  return [decorations, highlights]
enddef

def GetAnnotations(termbufnr: number): list<dict<any>>
  const rows = term_getsize(termbufnr)[0]
  var annons = []

  for row in range(1, rows + 1)
    const rawAnnons = term_scrape(termbufnr, row)
    if rawAnnons->empty()
      continue
    endif

    var concated = [
      {row: row, col: 1, width: strlen(rawAnnons[0].chars) ?? rawAnnons[0].width}
        ->extend(rawAnnons[0], 'keep')
    ]
    var prev = concated[-1]

    for annon in rawAnnons[1 :]
      if annon.attr == prev.attr && annon.bg ==# prev.bg && annon.fg ==# prev.fg
        prev.width += strlen(annon.chars) ?? annon.width
      else
        final base = {
          row: row,
          col: prev.col + prev.width,
          width: strlen(annon.chars) ?? annon.width,
        }
        concated->add(base->extend(annon, 'keep'))
        prev = concated[-1]
      endif
    endfor
    annons->extend(concated)
  endfor

  return annons
enddef

def GetHighlightName(annon: dict<any>, attr: dict<bool>): string
  const id = [
    'F' .. annon.fg[1 :],
    'B' .. annon.bg[1 :],
    attr.bold ? "Bold" : "",
    attr.reverse ? "Reverse" : "",
    attr.italic ? "Italic" : "",
    attr.strike ? "Strike" : "",
    attr.underline ? "Underline" : "",
  ]->join('')
  return $'DduUiFfVimPopup{id}'
enddef

def GetHighlightDict(name: string, annon: dict<any>, attr: dict<bool>): dict<any>
  return {
    term: attr,
    cterm: attr,
    gui: attr,
    force: true,
    guifg: annon.fg,
    guibg: annon.bg,
    name: name,
  }
enddef

def GetColorMap(termbufnr: number): dict<string>
  const guicolors = term_getansicolors(termbufnr)
  const ctermcolors = [
    'black',
    'darkred',
    'darkgreen',
    'brown',
    'darkblue',
    'darkmagenta',
    'darkcyan',
    'lightgrey',
    'darkgrey',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
  ]
  var colorMap = {}
  guicolors->foreach((i: number, guicolor: string) => {
    colorMap[guicolor] = ctermcolors[i]
  })
  return colorMap
enddef
