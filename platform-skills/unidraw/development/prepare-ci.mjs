// This provider depends only on Node built-ins. Browser provisioning is owned
// by the signed host, never the package build or the pure CI fixtures.
if (!['package','test'].includes(process.argv[2])) process.exitCode=2;
