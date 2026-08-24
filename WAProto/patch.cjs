const fs = require('node:fs');
const path = require('node:path');

const pbjsPath = require.resolve(
  'protobufjs/src/parse.js',
  {
    paths: [
      path.dirname(
        require.resolve(
          'protobufjs-cli/package.json',
          { paths: [process.env.APPDATA + '\\npm\\node_modules'] }
        )
      )
    ]
  }
);

const source = fs.readFileSync(pbjsPath, 'utf8');

const incompatibleGuard = [
  '                case "required":',
  '                    if (edition !== "proto2")',
  '                        throw illegal(token);',
].join('\n');

const compatibleCase = '                case "required":';

if (source.includes(incompatibleGuard)) {
  fs.writeFileSync(
    pbjsPath,
    source.replace(incompatibleGuard, compatibleCase)
  );

  console.log(
    `Patched ${pbjsPath} for WhatsApp's legacy proto3 required fields.`
  );
} else if (source.includes(compatibleCase)) {
  console.log(`Already patched: ${pbjsPath}`);
} else {
  throw new Error(
    'The protobufjs parser changed and the required-field compatibility patch must be reviewed.'
  );
}