#!/bin/bash
out="D:/workSpace/feishu/_research/$1"
url="$2"
code=$(curl -sL -m 40 -H "Accept: text/markdown" -o "$out" -w "%{http_code}" "$url")
echo "$code $(wc -c < "$out") $1"
