describe('redirect', function () {
  before(function () {
    this.app.use(function (req, res, next) {
      req.originalUrl = req.url =
        req.originalUrl.replace(/\/snow(\/|$)/, '/snow \u2603$1')
      next()
    })
  })
})
