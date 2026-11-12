module.exports = {
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        // includes, excludes are in tsconfig.json
        test: /\.ts?$/,
        exclude: /node_modules/,
        use: 'ts-loader'
      },
      {
        test: /\.jsx$/,
        include: /scripts/,
        type: 'asset/source'
      }
    ]
  },
  output: {
    filename: 'bundle.js'
  }
}