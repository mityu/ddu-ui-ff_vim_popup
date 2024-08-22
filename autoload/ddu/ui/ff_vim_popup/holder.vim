vim9script

class Id
  var _id: number

  def new()
    this._id = 0
  enddef

  def GetNewId(): number
    ++this._id
    return this._id
  enddef
endclass

export class Holder
  var _holder: dict<any>
  var _id: Id

  def new()
    this._holder = {}
    this._id = Id.new()
  enddef

  def Add(obj: any): string
    const id = this._id.GetNewId()->string()
    this._holder[id] = obj
    return id
  enddef

  def Get(id: string): any
    return this._holder[id]
  enddef

  def Dispose(id: string): any
    return remove(this._holder, id)
  enddef
endclass
