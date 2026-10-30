#!/bin/bash
# usage: tools/batch.sh LAPS DIFF MODE  -> total incidents over 5 tracks x 3 seeds
cd "$(dirname "$0")/.."
tot_r=0; tot_w=0; tot_c=0
for t in kestrel varenna lucerne hakone rimal; do for s in 3 7 11; do
  l=$(SEED=$s node tools/simrace.js $t $1 $2 $3 2>&1 | grep -m1 "^walls")
  w=$(echo $l | awk '{print $2}'); c=$(echo $l | awk '{print $4}'); r=$(echo $l | awk '{print $6}')
  tot_r=$((tot_r+r)); tot_w=$((tot_w+w)); tot_c=$((tot_c+c)); echo "$t s$s $l"
done; done
echo "TOTAL recoveries $tot_r walls $tot_w contacts $tot_c"
